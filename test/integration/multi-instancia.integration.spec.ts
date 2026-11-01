import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "bun";
import { GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { carregarConfiguracao, type Configuracao } from "../../src/infrastructure/config";
import { criarClienteSqs } from "../../src/infrastructure/mensageria/sqs/cliente-sqs";
import { criarFilas } from "../../src/infrastructure/mensageria/sqs/filas";
import { conferirInvariantes, INTEGRACAO_HABILITADA, prepararBanco, URL_DO_BANCO_DE_TESTE, type BancoDeTeste } from "../support/database";
import { idExterno } from "../support/cenarios";

// Várias instâncias reais da API (processos separados) contra o mesmo PostgreSQL e o mesmo SQS (MiniStack).
// Rodar com: INTEGRATION=1 INTEGRATION_SQS=1 bun test test/integration/multi-instancia
// Pré-requisito: bun run infra:up (PostgreSQL + MiniStack no ar)
const HABILITADO = INTEGRACAO_HABILITADA && process.env["INTEGRATION_SQS"] === "1";

interface Instancia {
    readonly porta: number;
    readonly processo: ReturnType<typeof spawn>;
}

describe.skipIf(!HABILITADO)("várias instâncias + SQS", () => {
    let banco: BancoDeTeste;
    let sqs: SQSClient;
    let filas: Configuracao["sqs"];
    let instancias: Instancia[] = [];
    const sufixo = Date.now().toString(36);

    function ambiente(porta: number, extra: Record<string, string> = {}): Record<string, string | undefined> {
        return {
            ...process.env,
            PORT: String(porta),
            AUTH_MODE: "disabled",
            WORKERS_ENABLED: "true",
            DATABASE_URL: URL_DO_BANCO_DE_TESTE,
            SQS_WAGER_QUEUE: filas.filaDeTransacoes,
            SQS_WAGER_DLQ: filas.filaDeTransacoesDlq,
            SQS_EVENTS_QUEUE: filas.filaDeEventos,
            SQS_VISIBILITY_TIMEOUT_S: "2",
            OUTBOX_INTERVAL_MS: "100",
            PENDING_INTERVAL_MS: "100",
            PENDING_BASE_DELAY_MS: "50",
            HTTPS_KEY: "",
            HTTPS_CERT: "",
            ...extra,
        };
    }

    async function esperarPronta(porta: number): Promise<void> {
        for (let i = 0; i < 100; i++) {
            try {
                const r = await fetch("http://localhost:" + porta + "/health/ready");
                if (r.status === 200) return;
            } catch {
                // ainda subindo
            }
            await Bun.sleep(300);
        }
        throw new Error("Instância na porta " + porta + " não ficou pronta");
    }

    async function subir(porta: number, extra: Record<string, string> = {}): Promise<Instancia> {
        const processo = spawn(["bun", "src/main.ts"], { env: ambiente(porta, extra), stdout: "ignore", stderr: "inherit" });
        const instancia = { porta, processo };
        await esperarPronta(porta);
        return instancia;
    }

    async function derrubar(i: Instancia): Promise<void> {
        i.processo.kill(15); // SIGTERM: desligamento ordenado
        await i.processo.exited;
    }

    async function esperar(condicao: () => Promise<boolean>, ms = 30_000): Promise<void> {
        const limite = Date.now() + ms;
        while (Date.now() < limite) {
            if (await condicao()) return;
            await Bun.sleep(200);
        }
        throw new Error("Condição não atingida em " + ms + "ms");
    }

    async function urlDa(nome: string): Promise<string> {
        const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: nome }));
        if (QueueUrl === undefined) throw new Error("fila " + nome);
        return QueueUrl;
    }

    async function criarCarteira(porta: number, saldo: string): Promise<{ id: string; playerId: string }> {
        const playerId = idExterno("player");
        const r = await fetch("http://localhost:" + porta + "/wallets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ playerId, initialBalance: { amount: saldo, currency: "BRL" } }),
        });
        const corpo = (await r.json()) as { id: string };
        return { id: corpo.id, playerId };
    }

    function aposta(c: { id: string; playerId: string }, tipo: string, valor: string, extra: Record<string, unknown> = {}) {
        return {
            providerId: "prov-1", externalTransactionId: idExterno(tipo.toLowerCase()), kind: tipo, playerId: c.playerId,
            walletId: c.id, money: { amount: valor, currency: "BRL" }, roundId: "round-1", ...extra,
        };
    }

    /** Envelope da fila: { messageId, type, occurredAt, data } */
    function envelope(dados: { readonly externalTransactionId: string }, messageId: string = "msg-" + dados.externalTransactionId): string {
        return JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: dados });
    }

    /** Soma uma métrica (todas as séries) no /metrics de uma instância */
    async function metrica(porta: number, nome: string): Promise<number> {
        const texto = await (await fetch("http://localhost:" + porta + "/metrics")).text();
        return texto
            .split("\n")
            .filter((l) => l.startsWith(nome + " ") || l.startsWith(nome + "{"))
            .reduce((total, l) => total + Number(l.split(" ").at(-1)), 0);
    }

    /**
     * Segura o lock da carteira numa transação do próprio teste, como uma operação lenta faria.
     * Devolve a função que solta o lock (commit). Enquanto isso, quem processar essa carteira espera.
     */
    async function travarCarteira(walletId: string): Promise<() => Promise<void>> {
        let soltar: () => void = () => undefined;
        const liberado = new Promise<void>((r) => (soltar = r));
        let travou: () => void = () => undefined;
        const travado = new Promise<void>((r) => (travou = r));
        const transacao = banco.sql.begin(async (tx) => {
            await tx.unsafe("select id from wallets where id = $1 for update", [walletId]);
            travou();
            await liberado;
        });
        await travado;
        return async () => {
            soltar();
            await transacao;
        };
    }

    async function lancamentosDe(externalTransactionId: string): Promise<number> {
        const [l] = await banco.sql.unsafe(
            "select count(*)::int as n from ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.external_transaction_id = $1",
            [externalTransactionId]
        );
        return (l as { n: number }).n;
    }

    async function saldo(walletId: string): Promise<string> {
        const [l] = await banco.sql.unsafe("select balance::text as b from wallets where id = $1", [walletId]);
        return String((l as { b: string }).b);
    }

    beforeAll(async () => {
        banco = await prepararBanco();
        const base = carregarConfiguracao();
        filas = {
            ...base.sqs,
            filaDeTransacoes: "wager-transactions-" + sufixo + ".fifo",
            filaDeTransacoesDlq: "wager-transactions-dlq-" + sufixo + ".fifo",
            filaDeEventos: "wallet-events-" + sufixo + ".fifo",
            visibilidadeSegundos: 2,
        };
        sqs = criarClienteSqs(filas);
        await criarFilas(sqs, filas);
        instancias = await Promise.all([3101, 3102, 3103].map((p) => subir(p)));
    }, 60_000);

    afterEach(async () => {
        await conferirInvariantes(banco.sql);
    });

    afterAll(async () => {
        await Promise.all(instancias.map(derrubar));
        sqs?.destroy();
        await banco?.fechar();
    }, 60_000);

    it("50 BETs idênticos espalhados por 3 instâncias geram um único débito", async () => {
        const c = await criarCarteira(3101, "100.00");
        const corpo = aposta(c, "BET", "10.00");
        const respostas = await Promise.all(
            Array.from({ length: 50 }, (_, i) =>
                fetch("http://localhost:" + String(3101 + (i % 3)) + "/wagering/transactions", {
                    method: "POST",
                    headers: { "content-type": "application/json", "idempotency-key": "multi-" + corpo.externalTransactionId },
                    body: JSON.stringify(corpo),
                })
            )
        );
        expect(respostas.every((r) => r.status === 201)).toBe(true);
        expect(await saldo(c.id)).toBe("9000");
    }, 60_000);

    it("disputa na mesma carteira entre instâncias: nunca fica negativa", async () => {
        const c = await criarCarteira(3101, "30.00");
        const respostas = await Promise.all(
            Array.from({ length: 60 }, (_, i) => {
                const corpo = aposta(c, "BET", "1.00");
                return fetch("http://localhost:" + String(3101 + (i % 3)) + "/wagering/transactions", {
                    method: "POST",
                    headers: { "content-type": "application/json", "idempotency-key": corpo.externalTransactionId },
                    body: JSON.stringify(corpo),
                });
            })
        );
        expect(respostas.filter((r) => r.status === 201)).toHaveLength(30);
        expect(respostas.filter((r) => r.status === 422)).toHaveLength(30);
        expect(await saldo(c.id)).toBe("0");
    }, 60_000);

    it("mensagens da fila, inclusive repetidas e fora de ordem, chegam a um estado consistente", async () => {
        const c = await criarCarteira(3101, "50.00");
        const url = await urlDa(filas.filaDeTransacoes);
        const bets = Array.from({ length: 10 }, () => aposta(c, "BET", "1.00"));
        // ROLLBACK do primeiro BET enviado ANTES do BET (referência fora de ordem)
        const rollback = aposta(c, "ROLLBACK", "1.00", { referenceExternalTransactionId: bets[0]?.externalTransactionId });
        // Repetições de dois tipos: o produtor reenvia a mesma mensagem (mesmo messageId: a inbox descarta)
        // e um envio novo da mesma transação (outro messageId: a idempotência devolve o resultado original)
        const corpos = [
            envelope(rollback),
            ...bets.map((b) => envelope(b)),
            ...bets.slice(0, 3).map((b) => envelope(b)),
            ...bets.slice(3, 5).map((b) => envelope(b, "reenvio-" + b.externalTransactionId)),
        ];
        for (const corpo of corpos) {
            await sqs.send(new SendMessageCommand({
                QueueUrl: url,
                MessageBody: corpo,
                MessageGroupId: idExterno("grupo"),
                MessageDeduplicationId: crypto.randomUUID(),
            }));
        }
        // 50 - 10 + 1 (rollback do primeiro) = 41
        await esperar(async () => (await saldo(c.id)) === "4100");
        await Bun.sleep(1500);
        expect(await saldo(c.id)).toBe("4100");
    }, 60_000);

    it("processo que cai depois do commit e antes do ack não duplica o efeito", async () => {
        const c = await criarCarteira(3101, "20.00");
        // Deixa só a instância que vai cair consumindo a fila
        await Promise.all(instancias.map(derrubar));
        instancias = [];

        const quebrada = spawn(["bun", "src/main.ts"], {
            env: ambiente(3105, { FAULT_CRASH_AFTER_COMMIT: "true" }),
            stdout: "ignore",
            stderr: "inherit",
        });
        const bet = aposta(c, "BET", "5.00");
        await sqs.send(new SendMessageCommand({
            QueueUrl: await urlDa(filas.filaDeTransacoes),
            MessageBody: envelope(bet),
            MessageGroupId: c.id,
            MessageDeduplicationId: crypto.randomUUID(),
        }));
        expect(await quebrada.exited).toBe(137);
        expect(await saldo(c.id)).toBe("1500"); // commit aconteceu

        // Uma instância normal recebe a mensagem de novo (não houve ack) e a inbox descarta
        const nova = await subir(3101);
        instancias = [nova];
        await esperar(async () => {
            const metricas = await (await fetch("http://localhost:3101/metrics")).text();
            return /wager_duplicate_messages_total [1-9]/.test(metricas);
        });
        expect(await saldo(c.id)).toBe("1500");
        const [lancamentos] = await banco.sql.unsafe(
            "select count(*)::int as n from ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.external_transaction_id = $1",
            [bet.externalTransactionId]
        );
        expect(lancamentos).toEqual({ n: 1 });
    }, 90_000);

    it("falha passageira (lock esgotado) devolve a mensagem à fila com backoff e ela é aplicada uma vez depois", async () => {
        // Uma instância com lock_timeout curto, para a espera pelo lock virar falha passageira rápido
        await Promise.all(instancias.map(derrubar));
        instancias = [await subir(3106, { LOCK_TIMEOUT_MS: "300" })];
        const c = await criarCarteira(3106, "10.00");
        const bet = aposta(c, "BET", "2.00");

        const soltar = await travarCarteira(c.id);
        try {
            await sqs.send(new SendMessageCommand({
                QueueUrl: await urlDa(filas.filaDeTransacoes),
                MessageBody: envelope(bet),
                MessageGroupId: c.id,
                MessageDeduplicationId: crypto.randomUUID(),
            }));
            // A instância tenta, estoura o lock_timeout (3 vezes, com retentativa interna) e devolve a mensagem
            await esperar(async () => (await metrica(3106, "wager_lock_conflicts_total")) >= 1);
            await esperar(async () => (await metrica(3106, "wager_retries_total{reason=\"queue-transient\"}")) >= 1);
            expect(await saldo(c.id)).toBe("1000"); // nada aplicado enquanto o lock está preso
        } finally {
            await soltar();
        }

        // Depois do backoff, a mensagem volta e é aplicada exatamente uma vez
        await esperar(async () => (await saldo(c.id)) === "800");
        await Bun.sleep(1500);
        expect(await saldo(c.id)).toBe("800");
        expect(await lancamentosDe(bet.externalTransactionId)).toBe(1);
    }, 90_000);

    it("SIGTERM termina a mensagem em curso, devolve as outras, e o reinício não duplica nada", async () => {
        await Promise.all(instancias.map(derrubar));
        const instancia = await subir(3107);
        instancias = [instancia];
        const c = await criarCarteira(3107, "50.00");
        const bets = Array.from({ length: 6 }, () => aposta(c, "BET", "1.00"));

        // Com o lock preso, a primeira mensagem fica em processamento (esperando o lock) e as outras na fila
        const soltar = await travarCarteira(c.id);
        const url = await urlDa(filas.filaDeTransacoes);
        for (const b of bets) {
            await sqs.send(new SendMessageCommand({
                QueueUrl: url, MessageBody: envelope(b), MessageGroupId: c.id, MessageDeduplicationId: crypto.randomUUID(),
            }));
        }
        await Bun.sleep(1500); // tempo para a instância receber o lote e começar a primeira

        // SIGTERM com a mensagem em curso; o processo espera ela terminar antes de sair
        instancia.processo.kill(15);
        await Bun.sleep(500);
        expect(instancia.processo.exitCode).toBeNull(); // ainda vivo: esperando a mensagem em curso
        await soltar();
        await instancia.processo.exited;
        instancias = [];

        // Um processo novo pega o que foi devolvido; cada BET é aplicado exatamente uma vez
        instancias = [await subir(3101)];
        await esperar(async () => (await saldo(c.id)) === "4400");
        await Bun.sleep(1500);
        expect(await saldo(c.id)).toBe("4400");
        for (const b of bets) expect(await lancamentosDe(b.externalTransactionId)).toBe(1);
    }, 90_000);

    it("mensagem inválida vai para a DLQ com o motivo, sem efeito no saldo", async () => {
        const c = await criarCarteira(instancias[0]?.porta ?? 3101, "10.00");
        const invalida = { ...aposta(c, "BET", "1.00"), money: { amount: 1, currency: "BRL" } }; // valor numérico: permanente
        await sqs.send(new SendMessageCommand({
            QueueUrl: await urlDa(filas.filaDeTransacoes),
            MessageBody: envelope(invalida),
            MessageGroupId: c.id,
            MessageDeduplicationId: crypto.randomUUID(),
        }));
        const dlq = await urlDa(filas.filaDeTransacoesDlq);
        let motivo: string | undefined;
        await esperar(async () => {
            const r = await sqs.send(new ReceiveMessageCommand({
                QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ["All"],
            }));
            for (const m of r.Messages ?? []) {
                const corpo = JSON.parse(m.Body ?? "{}") as { messageId?: string };
                if (corpo.messageId === "msg-" + invalida.externalTransactionId) motivo = m.MessageAttributes?.["failureReason"]?.StringValue;
            }
            return motivo !== undefined;
        });
        expect(motivo).toMatch(/money\.amount/);
        expect(await saldo(c.id)).toBe("1000");
    }, 60_000);

    it("eventos saem pelo outbox para a fila de eventos, sem repetir eventId", async () => {
        const url = await urlDa(filas.filaDeEventos);
        await esperar(async () => {
            const [pendentes] = await banco.sql.unsafe("select count(*)::int as n from outbox_events where published_at is null");
            return (pendentes as { n: number }).n === 0;
        });
        const vistos = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
            for (const m of r.Messages ?? []) {
                const envelope = JSON.parse(m.Body ?? "{}") as { eventId: string };
                expect(vistos.has(envelope.eventId)).toBe(false);
                vistos.add(envelope.eventId);
            }
            if ((r.Messages ?? []).length === 0) break;
        }
        expect(vistos.size).toBeGreaterThan(0);
    }, 60_000);
});
