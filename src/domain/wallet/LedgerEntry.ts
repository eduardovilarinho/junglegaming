import { RegraDeDominioViolada } from "../identidade/Erros";
import type { Money } from "../shared/Money";

export type LedgerDirection = "CREDIT" | "DEBIT";

export interface LedgerEntryProps {
    readonly id: string;
    readonly walletId: string;
    readonly transactionId: string;
    /** Versão da carteira depois deste lançamento: numera o histórico da carteira sem buracos */
    readonly walletVersion: bigint;
    readonly direction: LedgerDirection;
    readonly amount: Money;
    readonly balanceBefore: Money;
    readonly balanceAfter: Money;
    readonly createdAt: Date;
}

// Lançamento do ledger: imutável. Não há métodos que alterem um lançamento;
// correções são feitas com um novo lançamento (ex.: ROLLBACK), nunca editando o antigo.
// No banco, uma trigger impede UPDATE e DELETE nesta tabela.
export class LedgerEntry {
    private constructor(private readonly props: LedgerEntryProps) {
        Object.freeze(this);
    }

    /** Novo lançamento, criado pela carteira ao mudar de saldo. Confere balanceBefore ± amount = balanceAfter. */
    static record(props: Omit<LedgerEntryProps, "id">): LedgerEntry {
        if (!props.amount.isPositive()) {
            throw new RegraDeDominioViolada("Lançamento precisa de valor positivo");
        }
        if (!props.amount.currency.equals(props.balanceBefore.currency) || !props.amount.currency.equals(props.balanceAfter.currency)) {
            throw new RegraDeDominioViolada("Lançamento e saldos precisam da mesma moeda");
        }
        const esperado =
            props.direction === "CREDIT"
                ? props.balanceBefore.minorUnits + props.amount.minorUnits
                : props.balanceBefore.minorUnits - props.amount.minorUnits;
        if (esperado !== props.balanceAfter.minorUnits) {
            throw new RegraDeDominioViolada("Lançamento inconsistente: saldo anterior ± valor deve ser igual ao saldo posterior");
        }
        return new LedgerEntry({ ...props, id: crypto.randomUUID() });
    }

    /** Reconstrói do banco, sem revalidar. */
    static rehydrate(props: LedgerEntryProps): LedgerEntry {
        return new LedgerEntry(props);
    }

    get id(): string { return this.props.id; }
    get walletId(): string { return this.props.walletId; }
    get transactionId(): string { return this.props.transactionId; }
    get walletVersion(): bigint { return this.props.walletVersion; }
    get direction(): LedgerDirection { return this.props.direction; }
    get amount(): Money { return this.props.amount; }
    get balanceBefore(): Money { return this.props.balanceBefore; }
    get balanceAfter(): Money { return this.props.balanceAfter; }
    get createdAt(): Date { return this.props.createdAt; }

    /** Efeito no saldo, com sinal: crédito soma, débito subtrai */
    signedMinorUnits(): bigint {
        return this.direction === "CREDIT" ? this.amount.minorUnits : -this.amount.minorUnits;
    }
}
