import type { Money } from "../domain/shared/Money";
import type { WagerTransaction } from "../domain/wagering/WagerTransaction";
import type { LedgerEntry } from "../domain/wallet/LedgerEntry";
import type { Wallet } from "../domain/wallet/Wallet";

// DTOs de saída: a camada de interface nunca recebe agregados.
// Dinheiro sai como { amount: "10.50", currency: "BRL" }: string decimal com 2 casas, nunca número.

export interface MoneyView {
    readonly amount: string;
    readonly currency: string;
}

export function moneyView(m: Money): MoneyView {
    return { amount: m.toDecimalString(), currency: m.currency.code };
}

export interface WalletView {
    readonly id: string;
    readonly playerId: string;
    readonly balance: MoneyView;
    /** Começa em 1 e só aumenta quando o saldo muda */
    readonly version: number;
    readonly createdAt: string;
}

export function walletView(w: Wallet): WalletView {
    return {
        id: w.id,
        playerId: w.playerId,
        balance: moneyView(w.balance),
        version: Number(w.version),
        createdAt: w.createdAt.toISOString(),
    };
}

export interface TransactionView {
    readonly transactionId: string;
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly kind: string;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly gameId: string | null;
    readonly money: MoneyView;
    readonly referenceExternalTransactionId: string | null;
    readonly referencedTransactionId: string | null;
    readonly status: string;
    readonly failureCode: string | null;
    /** Saldo observado ao concluir a transação; null enquanto pendente ou se a carteira não existe */
    readonly balance: MoneyView | null;
    readonly attempts: number;
    readonly nextRetryAt: string | null;
    readonly createdAt: string;
    readonly processedAt: string | null;
}

export function transactionView(t: WagerTransaction): TransactionView {
    return {
        transactionId: t.id,
        providerId: t.providerId,
        externalTransactionId: t.externalTransactionId,
        kind: t.type,
        playerId: t.playerId,
        walletId: t.walletId,
        roundId: t.roundId,
        gameId: t.gameId,
        money: moneyView(t.amount),
        referenceExternalTransactionId: t.referenceExternalTransactionId,
        referencedTransactionId: t.referencedTransactionId,
        status: t.status,
        failureCode: t.failureCode,
        balance: t.balanceAfter === null ? null : moneyView(t.balanceAfter),
        attempts: t.attempts,
        nextRetryAt: t.nextRetryAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        processedAt: t.processedAt?.toISOString() ?? null,
    };
}

export interface LedgerEntryView {
    readonly id: string;
    readonly transactionId: string;
    readonly walletVersion: number;
    readonly direction: string;
    readonly money: MoneyView;
    readonly balanceBefore: MoneyView;
    readonly balanceAfter: MoneyView;
    readonly createdAt: string;
}

export function ledgerEntryView(e: LedgerEntry): LedgerEntryView {
    return {
        id: e.id,
        transactionId: e.transactionId,
        walletVersion: Number(e.walletVersion),
        direction: e.direction,
        money: moneyView(e.amount),
        balanceBefore: moneyView(e.balanceBefore),
        balanceAfter: moneyView(e.balanceAfter),
        createdAt: e.createdAt.toISOString(),
    };
}
