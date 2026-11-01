import type { SQL } from "bun";
import type { TransactionContext, UnitOfWork } from "../../src/application/ports";
import { traduzirErroDoBanco, type Linha, type SqlExecutor } from "../../src/infrastructure/persistencia/sql/SqlExecutor";
import { criarContextoSql } from "../../src/infrastructure/persistencia/sql/SqlTransactionContext";

/** Converte placeholders "?" para "$1, $2, ..." (estilo do cliente SQL do Bun) */
function paraPlaceholdersNumerados(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => "$" + String(++i));
}

// Mesma unidade de trabalho da aplicação, sobre o cliente PostgreSQL nativo do Bun.
// Os repositórios são os mesmos (SqlTransactionContext); muda só quem abre a transação.
// Usada nos testes de integração com TEST_DB_DRIVER=bun-sql.
export class BunSqlUnitOfWork implements UnitOfWork {
    constructor(
        private readonly sql: SQL,
        private readonly lockTimeoutMs = 5000
    ) {}

    async run<T>(trabalho: (ctx: TransactionContext) => Promise<T>): Promise<T> {
        try {
            const resultado: T = await this.sql.begin(async (tx) => {
                const db: SqlExecutor = {
                    query: async (q, parametros = []) =>
                        (await tx.unsafe(paraPlaceholdersNumerados(q), [...parametros])) as readonly Linha[],
                };
                await db.query("set local lock_timeout = " + Math.trunc(this.lockTimeoutMs));
                return trabalho(criarContextoSql(db));
            });
            return resultado;
        } catch (erro: unknown) {
            throw traduzirErroDoBanco(erro);
        }
    }
}
