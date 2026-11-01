import { TransientInfrastructureError, UniqueViolationError } from "../../../application/errors";

export type Linha = Readonly<Record<string, unknown>>;

// O mínimo que os repositórios precisam do banco: executar SQL dentro da transação atual.
// Placeholders no estilo "?" (os adaptadores convertem se o driver usar outro estilo).
export interface SqlExecutor {
    query(sql: string, parametros?: readonly unknown[]): Promise<readonly Linha[]>;
}

/** Código SQLSTATE do erro, venha ele do MikroORM (code) ou do cliente do Bun (errno) */
function sqlState(erro: unknown): string | null {
    if (typeof erro !== "object" || erro === null) return null;
    for (const campo of ["errno", "code", "sqlState"]) {
        const valor = (erro as Readonly<Record<string, unknown>>)[campo];
        if (typeof valor === "string" && /^[0-9A-Z]{5}$/.test(valor)) return valor;
    }
    return null;
}

function texto(erro: unknown, campo: string): string | null {
    if (typeof erro !== "object" || erro === null) return null;
    const valor = (erro as Readonly<Record<string, unknown>>)[campo];
    return typeof valor === "string" ? valor : null;
}

const SEM_CONEXAO = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated|connection closed|Connection refused/i;

// Traduz erros do driver para erros que a aplicação entende.
// O que não for reconhecido volta como está (vira 500 / erro permanente).
export function traduzirErroDoBanco(erro: unknown): unknown {
    const estado = sqlState(erro);
    switch (estado) {
        case "23505":
            return new UniqueViolationError(texto(erro, "constraint"));
        case "40P01":
            return new TransientInfrastructureError("Deadlock detectado pelo PostgreSQL", true, "deadlock");
        case "40001":
            return new TransientInfrastructureError("Falha de serialização", true, "serialization");
        case "55P03":
            return new TransientInfrastructureError("Tempo de espera por lock esgotado", true, "lock-timeout");
        case "53300":
            return new TransientInfrastructureError("Limite de conexões do PostgreSQL atingido (53300)", false, "unavailable");
        case "57P01":
        case "57P02":
        case "57P03":
            return new TransientInfrastructureError("Banco indisponível (" + estado + ")", false, "unavailable");
        default:
            break;
    }
    if (estado !== null && estado.startsWith("08")) {
        return new TransientInfrastructureError("Falha de conexão com o banco", false, "unavailable");
    }
    const mensagem = erro instanceof Error ? erro.message : "";
    const codigo = texto(erro, "code") ?? "";
    if (SEM_CONEXAO.test(mensagem) || SEM_CONEXAO.test(codigo)) {
        return new TransientInfrastructureError("Banco inacessível", false, "unavailable");
    }
    return erro;
}

// Conversão de colunas: o PostgreSQL devolve bigint como string (para não perder precisão)
export function textoDe(l: Linha, coluna: string): string {
    const v = l[coluna];
    if (typeof v !== "string") throw new Error("Coluna " + coluna + " deveria ser texto");
    return v;
}

export function textoOuNulo(l: Linha, coluna: string): string | null {
    const v = l[coluna];
    return v === null || v === undefined ? null : textoDe(l, coluna);
}

export function bigintDe(l: Linha, coluna: string): bigint {
    const v = l[coluna];
    if (typeof v === "bigint") return v;
    if (typeof v === "string" || typeof v === "number") return BigInt(v);
    throw new Error("Coluna " + coluna + " deveria ser numérica");
}

export function inteiroDe(l: Linha, coluna: string): number {
    return Number(bigintDe(l, coluna));
}

export function dataDe(l: Linha, coluna: string): Date {
    const v = l[coluna];
    if (v instanceof Date) return v;
    if (typeof v === "string") return new Date(v);
    throw new Error("Coluna " + coluna + " deveria ser data");
}

export function dataOuNula(l: Linha, coluna: string): Date | null {
    const v = l[coluna];
    return v === null || v === undefined ? null : dataDe(l, coluna);
}
