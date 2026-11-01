import { settle, type RetryPolicy } from "../../domain/wagering/WagerSettlement";
import type { Clock, UnitOfWork } from "../ports";
import { comRetentativas } from "../retry";
import type { Telemetry } from "../Telemetry";
import { buscarReferencia, gravarEfeitos } from "./ProcessWagerTransaction";

// Caso de uso do worker de pendências: pega transações PENDING_REFERENCE vencidas e tenta de novo.
// Cada pendência é tratada na própria transação SQL, travada com FOR UPDATE SKIP LOCKED:
// várias instâncias podem rodar o worker ao mesmo tempo sem pegar a mesma pendência.
export class ResumePendingTransactions {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly retryPolicy: RetryPolicy,
        private readonly telemetry: Telemetry,
        private readonly clock: Clock
    ) {}

    /** Processa até `limite` pendências vencidas; devolve quantas tratou. */
    async execute(limite: number): Promise<number> {
        let tratadas = 0;
        while (tratadas < limite) {
            const tratou = await comRetentativas(() => this.uow.run(async (ctx) => {
                const agora = this.clock();
                const pendente = await ctx.transactions.lockNextDuePending(agora);
                if (pendente === null) return false;

                const carteira = await ctx.wallets.lockById(pendente.walletId);
                const versao = carteira?.version ?? 0n;
                const referencia = await buscarReferencia(ctx, pendente);
                const outcome = settle({ transaction: pendente, wallet: carteira, reference: referencia, now: agora, retryPolicy: this.retryPolicy });

                await ctx.transactions.update(pendente);
                await gravarEfeitos(ctx, carteira, versao, pendente, outcome);
                if (pendente.isTerminal) {
                    this.telemetry.transactionSettled(pendente.type, pendente.status, agora.getTime() - pendente.createdAt.getTime());
                }
                return true;
            }), this.telemetry);
            if (!tratou) break;
            tratadas += 1;
        }
        return tratadas;
    }
}
