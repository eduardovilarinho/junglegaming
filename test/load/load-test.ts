// Teste de carga (bônus): bun run test:load
//
// Metodologia:
// - cria N carteiras com saldo alto e dispara BETs de 0.01 com concorrência fixa (trabalhadores em laço fechado),
//   por um tempo fixo, distribuindo os pedidos entre as instâncias de LOAD_URLS;
// - LOAD_DUPLICATE_RATIO dos pedidos repetem um pedido anterior idêntico (mesma Idempotency-Key e mesmo corpo),
//   como um provider que reenvia: a resposta deve ser 201 com Idempotent-Replayed, sem novo débito;
// - poucas carteiras para muitos trabalhadores concentram pedidos na mesma carteira (disputa pelo lock);
// - mede latência por pedido no cliente (p50/p95/p99), vazão, taxa de erro e distribuição de status;
// - lê /metrics de cada instância antes e depois: retentativas, conflitos de lock e atraso do outbox;
// - ao final, espera o outbox esvaziar e reconcilia todas as carteiras (saldo x ledger).
//
// Variáveis: LOAD_URLS (separadas por vírgula), LOAD_DURATION_S, LOAD_CONCURRENCY, LOAD_WALLETS, LOAD_DUPLICATE_RATIO.
// A API precisa estar no ar com AUTH_MODE=disabled.

const urls = (process.env["LOAD_URLS"] ?? "http://localhost:3000").split(",").map((u) => u.trim());
const duracaoMs = Number(process.env["LOAD_DURATION_S"] ?? "20") * 1000;
const concorrencia = Number(process.env["LOAD_CONCURRENCY"] ?? "50");
const quantidadeDeCarteiras = Number(process.env["LOAD_WALLETS"] ?? "20");
const proporcaoDeRepetidos = Number(process.env["LOAD_DUPLICATE_RATIO"] ?? "0.1");

interface Carteira {
    readonly id: string;
    readonly playerId: string;
}

interface Pedido {
    readonly chave: string;
    readonly corpo: string;
}

let proxima = 0;
// Distribui em rodízio entre as instâncias
const urlDaVez = (): string => urls[proxima++ % urls.length] ?? "http://localhost:3000";

async function criarCarteiras(): Promise<Carteira[]> {
    const carteiras: Carteira[] = [];
    for (let i = 0; i < quantidadeDeCarteiras; i++) {
        const playerId = "load-" + Date.now().toString(36) + "-" + i;
        const r = await fetch(urlDaVez() + "/wallets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ playerId, initialBalance: { amount: "1000000.00", currency: "BRL" } }),
        });
        if (r.status !== 201) throw new Error("Falha ao criar carteira: " + r.status + " " + (await r.text()));
        const corpo = (await r.json()) as { id: string };
        carteiras.push({ id: corpo.id, playerId });
    }
    return carteiras;
}

function percentil(ordenado: readonly number[], p: number): number {
    if (ordenado.length === 0) return 0;
    return ordenado[Math.min(ordenado.length - 1, Math.ceil((p / 100) * ordenado.length) - 1)] ?? 0;
}

/** Soma uma métrica (todas as séries) em todas as instâncias */
async function somarMetrica(nome: string): Promise<number> {
    let total = 0;
    for (const url of urls) {
        try {
            const texto = await (await fetch(url + "/metrics")).text();
            for (const linha of texto.split("\n")) {
                if (linha.startsWith(nome + " ") || linha.startsWith(nome + "{")) total += Number(linha.split(" ").at(-1));
            }
        } catch {
            // instância fora do ar: não soma
        }
    }
    return total;
}

async function maiorAtrasoDoOutbox(): Promise<number> {
    let maior = 0;
    for (const url of urls) {
        try {
            const texto = await (await fetch(url + "/metrics")).text();
            maior = Math.max(maior, Number(/^outbox_lag_seconds ([\d.]+)/m.exec(texto)?.[1] ?? "0"));
        } catch {
            // ignora
        }
    }
    return maior;
}

async function executar(): Promise<void> {
    console.log("Preparando " + quantidadeDeCarteiras + " carteiras em " + urls.join(", ") + "...");
    const carteiras = await criarCarteiras();
    const antes = {
        retentativas: await somarMetrica("wager_retries_total"),
        conflitosDeLock: await somarMetrica("wager_lock_conflicts_total"),
        duplicados: await somarMetrica("wager_duplicate_requests_total"),
    };

    const latencias: number[] = [];
    const porStatus = new Map<number, number>();
    let repeticoesEnviadas = 0;
    let repeticoesConfirmadas = 0;
    let falhasDeRede = 0;
    let sequencia = 0;
    let maiorAtrasoDuranteACarga = 0;
    const recentes: Pedido[] = [];
    const fim = Date.now() + duracaoMs;
    const inicio = performance.now();

    const amostrador = setInterval(() => {
        void maiorAtrasoDoOutbox().then((s) => (maiorAtrasoDuranteACarga = Math.max(maiorAtrasoDuranteACarga, s)));
    }, 1000);

    async function trabalhador(): Promise<void> {
        while (Date.now() < fim) {
            sequencia += 1;
            const repetir = Math.random() < proporcaoDeRepetidos && recentes.length > 0;
            let pedido: Pedido;
            if (repetir) {
                pedido = recentes[Math.floor(Math.random() * recentes.length)] ?? { chave: "x", corpo: "{}" };
                repeticoesEnviadas += 1;
            } else {
                const carteira = carteiras[sequencia % carteiras.length];
                if (carteira === undefined) return;
                const externo = "load-" + Date.now().toString(36) + "-" + sequencia;
                pedido = {
                    chave: "load-provider:" + externo,
                    corpo: JSON.stringify({
                        providerId: "load-provider", externalTransactionId: externo, kind: "BET", playerId: carteira.playerId,
                        walletId: carteira.id, money: { amount: "0.01", currency: "BRL" }, roundId: "load-round",
                    }),
                };
                recentes.push(pedido);
                if (recentes.length > 200) recentes.shift();
            }
            const t0 = performance.now();
            try {
                const r = await fetch(urlDaVez() + "/wagering/transactions", {
                    method: "POST",
                    headers: { "content-type": "application/json", "idempotency-key": pedido.chave },
                    body: pedido.corpo,
                });
                await r.arrayBuffer();
                porStatus.set(r.status, (porStatus.get(r.status) ?? 0) + 1);
                if (r.headers.get("idempotent-replayed") === "true") repeticoesConfirmadas += 1;
            } catch {
                falhasDeRede += 1;
            }
            latencias.push(performance.now() - t0);
        }
    }

    await Promise.all(Array.from({ length: concorrencia }, trabalhador));
    const segundos = (performance.now() - inicio) / 1000;
    clearInterval(amostrador);

    // Espera o outbox publicar tudo (até 60s)
    const inicioDaDrenagem = performance.now();
    let atrasoFinal = await maiorAtrasoDoOutbox();
    while (atrasoFinal > 0 && performance.now() - inicioDaDrenagem < 60_000) {
        await Bun.sleep(500);
        atrasoFinal = await maiorAtrasoDoOutbox();
    }
    const drenagem = (performance.now() - inicioDaDrenagem) / 1000;

    // Consistência final: saldo de cada carteira = soma do ledger
    let inconsistentes = 0;
    for (const c of carteiras) {
        const r = await fetch(urlDaVez() + "/wallets/" + c.id + "/reconciliation", { method: "POST" });
        const corpo = (await r.json()) as { consistent?: boolean };
        if (corpo.consistent !== true) inconsistentes += 1;
    }

    const depois = {
        retentativas: await somarMetrica("wager_retries_total"),
        conflitosDeLock: await somarMetrica("wager_lock_conflicts_total"),
        duplicados: await somarMetrica("wager_duplicate_requests_total"),
    };
    const ordenado = [...latencias].sort((a, b) => a - b);
    const total = latencias.length;
    const erros = falhasDeRede + [...porStatus].filter(([s]) => s >= 500).reduce((a, [, n]) => a + n, 0);

    console.log("\n=== Resultado ===");
    console.log(
        "Ambiente: Bun " + Bun.version + " (" + process.platform + "/" + process.arch + "), " + urls.length + " instância(s), concorrência " +
            concorrencia + ", " + quantidadeDeCarteiras + " carteiras, " + duracaoMs / 1000 + "s, " + proporcaoDeRepetidos * 100 + "% repetidos"
    );
    console.log("Pedidos: " + total + " | vazão: " + (total / segundos).toFixed(1) + " req/s");
    console.log(
        "Latência no cliente (ms): p50 " + percentil(ordenado, 50).toFixed(1) + " | p95 " + percentil(ordenado, 95).toFixed(1) +
            " | p99 " + percentil(ordenado, 99).toFixed(1) + " | máx " + (ordenado.at(-1) ?? 0).toFixed(1)
    );
    console.log("Status: " + [...porStatus].sort(([a], [b]) => a - b).map(([s, n]) => s + "=" + n).join(" "));
    console.log("Taxa de erro (5xx + rede): " + ((erros / Math.max(total, 1)) * 100).toFixed(2) + "%");
    console.log("Repetições: enviadas " + repeticoesEnviadas + ", respondidas como replay " + repeticoesConfirmadas +
        " (métrica no servidor: +" + (depois.duplicados - antes.duplicados) + ")");
    console.log(
        "Concorrência no servidor: retentativas +" + (depois.retentativas - antes.retentativas) +
            ", lock esgotado +" + (depois.conflitosDeLock - antes.conflitosDeLock) + ", 503 no cliente " + (porStatus.get(503) ?? 0)
    );
    console.log(
        "Outbox: maior atraso durante a carga " + maiorAtrasoDuranteACarga.toFixed(2) + "s; esvaziou " +
            (atrasoFinal === 0 ? "em " + drenagem.toFixed(1) + "s após o fim" : "NÃO (atraso " + atrasoFinal.toFixed(2) + "s após 60s)")
    );
    console.log("Reconciliação: " + (carteiras.length - inconsistentes) + "/" + carteiras.length + " carteiras consistentes");
}

executar().catch((erro: unknown) => {
    console.error(erro);
    process.exitCode = 1;
});
