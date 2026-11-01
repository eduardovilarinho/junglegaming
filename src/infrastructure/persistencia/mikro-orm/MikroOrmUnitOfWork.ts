import type { EntityManager } from "@mikro-orm/postgresql";
import type { TransactionContext, UnitOfWork } from "../../../application/ports";
import { traduzirErroDoBanco, type Linha, type SqlExecutor } from "../sql/SqlExecutor";
import { criarContextoSql } from "../sql/SqlTransactionContext";

// Unidade de trabalho sobre o MikroORM: cada run() é uma transação SQL num EntityManager
// próprio (fork), então funciona igual em requisições HTTP e nos workers, que não têm
// contexto de requisição. disableContextResolution: o fork sai sempre do EntityManager
// recebido, nunca do RequestContext da requisição (que pode ser de outro ORM, como nos testes).
export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(
        private readonly em: EntityManager,
        /** Quanto tempo uma transação espera por um lock antes de desistir (vira 503 / nova tentativa) */
        private readonly lockTimeoutMs: number
    ) {}

    async run<T>(trabalho: (ctx: TransactionContext) => Promise<T>): Promise<T> {
        try {
            return await this.em.fork({ disableContextResolution: true }).transactional(async (tem) => {
                const db: SqlExecutor = {
                    query: async (sql, parametros = []) => (await tem.execute(sql, [...parametros], "all")) as readonly Linha[],
                };
                await db.query("set local lock_timeout = " + Math.trunc(this.lockTimeoutMs));
                return trabalho(criarContextoSql(db));
            });
        } catch (erro: unknown) {
            throw traduzirErroDoBanco(erro);
        }
    }
}
