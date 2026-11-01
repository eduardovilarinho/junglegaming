import type { RetryPolicy } from "../domain/wagering/WagerSettlement";

export type ModoDeAutenticacao = "zitadel" | "desativada";

export interface Configuracao {
    readonly porta: number;
    readonly autenticacao: {
        /** "desativada" libera as rotas sem token (para avaliação local e testes de várias instâncias) */
        readonly modo: ModoDeAutenticacao;
    };
    readonly zitadel: {
        readonly issuer: string;
        readonly audience: string | undefined;
    };
    readonly banco: {
        readonly url: string;
        readonly debug: boolean;
        readonly maximoDeConexoes: number;
    };
    readonly financeiro: {
        /** Quanto uma transação espera pelo lock da carteira antes de desistir (503 / nova tentativa) */
        readonly lockTimeoutMs: number;
        /** Novas tentativas para referências ausentes */
        readonly pendencias: RetryPolicy;
    };
    readonly sqs: {
        readonly endpoint: string | undefined;
        readonly regiao: string;
        /** Credenciais explícitas; null = cadeia padrão da AWS (perfil, IAM role etc.) */
        readonly credenciais: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
        readonly filaDeTransacoes: string;
        readonly filaDeTransacoesDlq: string;
        readonly filaDeEventos: string;
        /** Entregas de uma mensagem antes de o SQS mover para a DLQ */
        readonly maximoDeEntregas: number;
        /** Tempo que uma mensagem fica invisível enquanto é processada */
        readonly visibilidadeSegundos: number;
    };
    readonly workers: {
        /** Liga o consumidor da fila, o publicador do outbox e o worker de pendências */
        readonly habilitados: boolean;
        readonly intervaloDoOutboxMs: number;
        readonly intervaloDePendenciasMs: number;
    };
    readonly falhasSimuladas: {
        /** SÓ PARA TESTES: o consumidor encerra o processo depois do commit e antes do ack */
        readonly encerrarDepoisDoCommit: boolean;
    };
    readonly https: {
        readonly chave: string;
        readonly certificado: string;
    } | null;
}

function lerUrl(nome: string, valor: string | undefined, padrao: string): string {
    const texto = valor === undefined || valor === "" ? padrao : valor;
    let url: URL;
    try {
        url = new URL(texto);
    } catch {
        throw new Error(nome + " inválida: " + texto + ". Use a URL completa, ex.: https://minha-instancia.zitadel.cloud");
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new Error(nome + " deve usar https://");
    }
    return texto.replace(/\/$/, "");
}

function lerUrlDoBanco(valor: string | undefined): string {
    const texto =
        valor === undefined || valor === ""
            ? "postgresql://postgres:postgres@localhost:5432/jungle_gaming"
            : valor;
    let url: URL;
    try {
        url = new URL(texto);
    } catch {
        throw new Error("DATABASE_URL inválida. Formato: postgresql://usuario:senha@host:5432/banco");
    }
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
        throw new Error("DATABASE_URL deve começar com postgresql://");
    }
    return texto;
}

function lerPorta(valor: string | undefined): number {
    if (valor === undefined || valor === "") return 3000;
    const porta = Number(valor);
    if (!Number.isInteger(porta) || porta <= 0 || porta > 65535) throw new Error("PORT inválida: " + valor);
    return porta;
}

function lerInteiro(nome: string, valor: string | undefined, padrao: number, minimo: number, maximo: number): number {
    if (valor === undefined || valor === "") return padrao;
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
        throw new Error(nome + " deve ser um inteiro entre " + minimo + " e " + maximo);
    }
    return numero;
}

function lerBooleano(nome: string, valor: string | undefined, padrao: boolean): boolean {
    if (valor === undefined || valor === "") return padrao;
    if (valor === "true" || valor === "1") return true;
    if (valor === "false" || valor === "0") return false;
    throw new Error(nome + " deve ser true ou false");
}

function lerModoDeAutenticacao(valor: string | undefined): ModoDeAutenticacao {
    if (valor === undefined || valor === "" || valor === "zitadel") return "zitadel";
    if (valor === "disabled") return "desativada";
    throw new Error("AUTH_MODE deve ser zitadel ou disabled");
}

function lerNomeDeFilaFifo(nome: string, valor: string | undefined, padrao: string): string {
    const texto = valor === undefined || valor === "" ? padrao : valor;
    if (!/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(texto)) throw new Error(nome + " deve ser um nome de fila FIFO (terminado em .fifo)");
    return texto;
}

function lerHttps(chave: string | undefined, certificado: string | undefined): Configuracao["https"] {
    if (!chave && !certificado) return null;
    if (!chave || !certificado) throw new Error("Defina HTTPS_KEY e HTTPS_CERT juntos");
    return { chave, certificado };
}

function lerCredenciaisAws(
    endpoint: string | undefined,
    accessKeyId: string | undefined,
    secretAccessKey: string | undefined
): { accessKeyId: string; secretAccessKey: string } | null {
    if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
    if (endpoint) return { accessKeyId: "test", secretAccessKey: "test" };
    return null;
}

export function carregarConfiguracao(env: NodeJS.ProcessEnv = process.env): Configuracao {
    return {
        porta: lerPorta(env["PORT"]),
        autenticacao: { modo: lerModoDeAutenticacao(env["AUTH_MODE"]) },
        zitadel: {
            issuer: lerUrl("ZITADEL_ISSUER", env["ZITADEL_ISSUER"], "http://localhost:8080"),
            audience: env["ZITADEL_PROJECT_ID"] || undefined,
        },
        banco: {
            url: lerUrlDoBanco(env["DATABASE_URL"]),
            debug: lerBooleano("DATABASE_DEBUG", env["DATABASE_DEBUG"], false),
            maximoDeConexoes: lerInteiro("DATABASE_POOL_MAX", env["DATABASE_POOL_MAX"], 10, 1, 500)
        },
        financeiro: {
            lockTimeoutMs: lerInteiro("LOCK_TIMEOUT_MS", env["LOCK_TIMEOUT_MS"], 5000, 100, 60_000),
            pendencias: {
                maxAttempts: lerInteiro("PENDING_MAX_ATTEMPTS", env["PENDING_MAX_ATTEMPTS"], 8, 1, 100),
                baseDelayMs: lerInteiro("PENDING_BASE_DELAY_MS", env["PENDING_BASE_DELAY_MS"], 1000, 10, 600_000),
                maxDelayMs: lerInteiro("PENDING_MAX_DELAY_MS", env["PENDING_MAX_DELAY_MS"], 60_000, 10, 3_600_000),
            },
        },
        sqs: {
            endpoint: env["SQS_ENDPOINT"] || undefined,
            regiao: env["AWS_REGION"] || "us-east-1",
            credenciais: lerCredenciaisAws(env["SQS_ENDPOINT"], env["AWS_ACCESS_KEY_ID"], env["AWS_SECRET_ACCESS_KEY"]),
            filaDeTransacoes: lerNomeDeFilaFifo("SQS_WAGER_QUEUE", env["SQS_WAGER_QUEUE"], "wager-transactions.fifo"),
            filaDeTransacoesDlq: lerNomeDeFilaFifo("SQS_WAGER_DLQ", env["SQS_WAGER_DLQ"], "wager-transactions-dlq.fifo"),
            filaDeEventos: lerNomeDeFilaFifo("SQS_EVENTS_QUEUE", env["SQS_EVENTS_QUEUE"], "wallet-events.fifo"),
            maximoDeEntregas: lerInteiro("SQS_MAX_RECEIVE_COUNT", env["SQS_MAX_RECEIVE_COUNT"], 5, 1, 1000),
            visibilidadeSegundos: lerInteiro("SQS_VISIBILITY_TIMEOUT_S", env["SQS_VISIBILITY_TIMEOUT_S"], 30, 1, 43_200),
        },
        workers: {
            habilitados: lerBooleano("WORKERS_ENABLED", env["WORKERS_ENABLED"], false),
            intervaloDoOutboxMs: lerInteiro("OUTBOX_INTERVAL_MS", env["OUTBOX_INTERVAL_MS"], 500, 50, 60_000),
            intervaloDePendenciasMs: lerInteiro("PENDING_INTERVAL_MS", env["PENDING_INTERVAL_MS"], 1000, 50, 60_000),
        },
        falhasSimuladas: {
            encerrarDepoisDoCommit: lerBooleano("FAULT_CRASH_AFTER_COMMIT", env["FAULT_CRASH_AFTER_COMMIT"], false),
        },
        https: lerHttps(env["HTTPS_KEY"], env["HTTPS_CERT"]),
    };
}
