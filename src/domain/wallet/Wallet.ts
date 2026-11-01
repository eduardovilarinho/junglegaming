import { RegraDeDominioViolada } from "../identidade/Erros";
import { InsufficientBalanceError } from "../shared/errors";
import { requireIdentifier } from "../shared/identifiers";
import { Money, type Currency } from "../shared/Money";
import { LedgerEntry, type LedgerDirection } from "./LedgerEntry";
import { WalletBalanceChanged } from "./WalletEvents";

export interface WalletProps {
    readonly id: string;
    readonly playerId: string;
    readonly currency: Currency;
    readonly balance: Money;
    readonly version: bigint;
    readonly createdAt: Date;
}

// O que uma mudança de saldo produz: o lançamento e o evento, gravados na mesma transação SQL
export interface BalanceChange {
    readonly entry: LedgerEntry;
    readonly event: WalletBalanceChanged;
    readonly previousBalance: Money;
}

// Agregado Wallet. Invariantes:
// - uma carteira por jogador e moeda (garantido também por UNIQUE no banco);
// - saldo nunca negativo (garantido também por CHECK no banco);
// - a versão começa em 1 na criação e só aumenta quando o saldo muda;
// - cada mudança de saldo gera exatamente um lançamento.
export class Wallet {
    private constructor(private props: WalletProps) {}

    /** Carteira nova, sem saldo: versão 1. */
    static open(params: { readonly id: string; readonly playerId: string; readonly currency: Currency; readonly now: Date }): Wallet {
        return new Wallet({
            id: params.id,
            playerId: requireIdentifier("playerId", params.playerId, 64),
            currency: params.currency,
            balance: Money.zero(params.currency),
            version: 1n,
            createdAt: params.now,
        });
    }

    /**
     * Carteira nova com saldo inicial: continua na versão 1 (a criação já inclui o saldo),
     * e o crédito de abertura vira o primeiro lançamento (walletVersion 1, saldo anterior 0).
     */
    static openWithInitialBalance(params: {
        readonly id: string;
        readonly playerId: string;
        readonly initialBalance: Money;
        readonly openingTransactionId: string;
        readonly now: Date;
    }): { readonly wallet: Wallet; readonly opening: BalanceChange } {
        if (!params.initialBalance.isPositive()) {
            throw new RegraDeDominioViolada("Saldo inicial precisa ser maior que zero");
        }
        const wallet = Wallet.open({ id: params.id, playerId: params.playerId, currency: params.initialBalance.currency, now: params.now });
        const opening = wallet.registrarMudanca("CREDIT", params.initialBalance, params.openingTransactionId, params.now, 1n);
        return { wallet, opening };
    }

    /** Reconstrói do banco, sem revalidar. */
    static rehydrate(props: WalletProps): Wallet {
        return new Wallet(props);
    }

    get id(): string { return this.props.id; }
    get playerId(): string { return this.props.playerId; }
    get currency(): Currency { return this.props.currency; }
    get balance(): Money { return this.props.balance; }
    get version(): bigint { return this.props.version; }
    get createdAt(): Date { return this.props.createdAt; }

    canDebit(valor: Money): boolean {
        return this.props.balance.isGreaterThanOrEqual(valor);
    }

    credit(valor: Money, transactionId: string, agora: Date): BalanceChange {
        return this.mudarSaldo("CREDIT", valor, transactionId, agora);
    }

    /** Lança InsufficientBalanceError se faltar saldo: as regras devem checar canDebit antes. */
    debit(valor: Money, transactionId: string, agora: Date): BalanceChange {
        if (!this.canDebit(valor)) {
            throw new InsufficientBalanceError("Saldo insuficiente na carteira " + this.props.id);
        }
        return this.mudarSaldo("DEBIT", valor, transactionId, agora);
    }

    private mudarSaldo(direcao: LedgerDirection, valor: Money, transactionId: string, agora: Date): BalanceChange {
        return this.registrarMudanca(direcao, valor, transactionId, agora, this.props.version + 1n);
    }

    private registrarMudanca(
        direcao: LedgerDirection,
        valor: Money,
        transactionId: string,
        agora: Date,
        versao: bigint
    ): BalanceChange {
        const anterior = this.props.balance;
        const novo = direcao === "CREDIT" ? anterior.add(valor) : anterior.subtract(valor);
        this.props = { ...this.props, balance: novo, version: versao };

        const entry = LedgerEntry.record({
            walletId: this.props.id,
            transactionId,
            walletVersion: versao,
            direction: direcao,
            amount: valor,
            balanceBefore: anterior,
            balanceAfter: novo,
            createdAt: agora,
        });
        const event = new WalletBalanceChanged(
            {
                walletId: this.props.id,
                playerId: this.props.playerId,
                transactionId,
                currency: this.props.currency.code,
                previousBalance: anterior.toDecimalString(),
                newBalance: novo.toDecimalString(),
                walletVersion: versao.toString(),
            },
            agora
        );
        return { entry, event, previousBalance: anterior };
    }
}
