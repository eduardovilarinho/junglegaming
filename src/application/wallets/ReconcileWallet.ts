import { isUuid } from "../../domain/shared/identifiers";
import { Money } from "../../domain/shared/Money";
import { NotFoundError } from "../errors";
import type { UnitOfWork } from "../ports";
import type { Telemetry } from "../Telemetry";
import type { MoneyView } from "../views";

export interface ReconciliationView {
    readonly walletId: string;
    readonly storedBalance: MoneyView;
    readonly calculatedBalance: MoneyView;
    /** Gravado menos calculado; pode ser negativo ("-1.00") quando há divergência */
    readonly difference: MoneyView;
    readonly consistent: boolean;
    /** Quantos lançamentos do ledger entraram na soma */
    readonly checkedEntries: number;
    readonly walletVersion: number;
}

// Compara o saldo gravado com o saldo recalculado a partir do ledger.
// Divergência é registrada (tabela reconciliation_reports), vira log de erro e métrica,
// mas NUNCA é corrigida automaticamente: corrigir esconderia o bug que causou a diferença.
export class ReconcileWallet {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly telemetry: Telemetry
    ) {}

    async execute(walletId: string): Promise<ReconciliationView> {
        if (!isUuid(walletId)) throw new NotFoundError("Carteira " + walletId + " não encontrada");

        const resultado = await this.uow.run(async (ctx) => {
            // Lock da carteira: nenhuma transação muda o saldo enquanto a soma é feita
            const w = await ctx.wallets.lockById(walletId);
            if (w === null) throw new NotFoundError("Carteira " + walletId + " não encontrada");
            const soma = await ctx.ledger.calculatedBalance(walletId);
            const armazenado = w.balance.minorUnits;
            const consistente = soma.balance === armazenado;
            await ctx.reconciliations.record({ walletId, storedBalance: armazenado, calculatedBalance: soma.balance, consistent: consistente });
            return { w, calculado: soma.balance, lancamentos: soma.entries, armazenado, consistente };
        });

        const { w, calculado, lancamentos, armazenado, consistente } = resultado;
        // Money não aceita negativo; a diferença de uma divergência pode ser, então o sinal é tratado aqui
        const formatar = (centavos: bigint): MoneyView => {
            const negativo = centavos < 0n;
            const texto = Money.fromMinorUnits(negativo ? -centavos : centavos, w.currency).toDecimalString();
            return { amount: negativo ? "-" + texto : texto, currency: w.currency.code };
        };
        const view: ReconciliationView = {
            walletId,
            storedBalance: formatar(armazenado),
            calculatedBalance: formatar(calculado),
            difference: formatar(armazenado - calculado),
            consistent: consistente,
            checkedEntries: lancamentos,
            walletVersion: Number(w.version),
        };
        if (!consistente) {
            this.telemetry.reconciliationDivergence(walletId, view.storedBalance.amount, view.calculatedBalance.amount);
        }
        return view;
    }
}
