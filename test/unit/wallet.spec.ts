import { describe, expect, it } from "bun:test";
import { InsufficientBalanceError } from "../../src/domain/shared/errors";
import { Currency, Money } from "../../src/domain/shared/Money";
import { LedgerEntry } from "../../src/domain/wallet/LedgerEntry";
import { Wallet } from "../../src/domain/wallet/Wallet";

const BRL = Currency.of("BRL");
const brl = (valor: string): Money => Money.fromDecimal(valor, BRL);
const agora = new Date("2026-11-01T12:00:00Z");

function carteira(): Wallet {
    return Wallet.open({ id: crypto.randomUUID(), playerId: "player-1", currency: BRL, now: agora });
}

describe("Wallet", () => {
    it("nasce com saldo zero e versão 1", () => {
        const w = carteira();
        expect(w.balance.isZero()).toBe(true);
        expect(w.version).toBe(1n);
    });

    it("com saldo inicial: continua na versão 1 e o crédito de abertura é o lançamento 1", () => {
        const { wallet, opening } = Wallet.openWithInitialBalance({
            id: crypto.randomUUID(), playerId: "player-1", initialBalance: brl("1000.00"), openingTransactionId: "t0", now: agora,
        });
        expect(wallet.version).toBe(1n);
        expect(wallet.balance.toDecimalString()).toBe("1000.00");
        expect(opening.entry.walletVersion).toBe(1n);
        expect(opening.entry.balanceBefore.toDecimalString()).toBe("0.00");
        expect(opening.entry.balanceAfter.toDecimalString()).toBe("1000.00");
        expect(() =>
            Wallet.openWithInitialBalance({ id: crypto.randomUUID(), playerId: "p", initialBalance: brl("0.00"), openingTransactionId: "t", now: agora })
        ).toThrow();
    });

    it("cada mudança de saldo incrementa a versão e gera um lançamento coerente", () => {
        const w = carteira();
        const credito = w.credit(brl("100.00"), "t1", agora);
        expect(w.balance.toDecimalString()).toBe("100.00");
        expect(w.version).toBe(2n);
        expect(credito.entry.walletVersion).toBe(2n);
        expect(credito.entry.direction).toBe("CREDIT");
        expect(credito.entry.balanceBefore.toDecimalString()).toBe("0.00");
        expect(credito.entry.balanceAfter.toDecimalString()).toBe("100.00");
        expect(credito.event.payload.previousBalance).toBe("0.00");
        expect(credito.event.payload.newBalance).toBe("100.00");

        const debito = w.debit(brl("30.50"), "t2", agora);
        expect(w.balance.toDecimalString()).toBe("69.50");
        expect(w.version).toBe(3n);
        expect(debito.entry.signedMinorUnits()).toBe(-3050n);
        expect(debito.entry.balanceBefore.toDecimalString()).toBe("100.00");
    });

    it("nunca fica negativa", () => {
        const w = carteira();
        w.credit(brl("10.00"), "t1", agora);
        expect(w.canDebit(brl("10.01"))).toBe(false);
        expect(() => w.debit(brl("10.01"), "t2", agora)).toThrow(InsufficientBalanceError);
        expect(w.balance.toDecimalString()).toBe("10.00");
        expect(w.version).toBe(2n);
    });

    it("saldo final é igual à soma dos lançamentos", () => {
        const w = carteira();
        const lancamentos = [
            w.credit(brl("50.00"), "a", agora),
            w.debit(brl("20.00"), "b", agora),
            w.credit(brl("5.25"), "c", agora),
        ].map((m) => m.entry);
        const soma = lancamentos.reduce((total, e) => total + e.signedMinorUnits(), 0n);
        expect(soma).toBe(w.balance.minorUnits);
    });

    it("lançamento confere saldo anterior ± valor = saldo posterior na factory", () => {
        const base = { walletId: "w", transactionId: "t", walletVersion: 2n, createdAt: agora };
        expect(() =>
            LedgerEntry.record({ ...base, direction: "DEBIT", amount: brl("5.00"), balanceBefore: brl("10.00"), balanceAfter: brl("6.00") })
        ).toThrow();
        expect(
            LedgerEntry.record({ ...base, direction: "DEBIT", amount: brl("5.00"), balanceBefore: brl("10.00"), balanceAfter: brl("5.00") })
                .balanceAfter.toDecimalString()
        ).toBe("5.00");
    });

    it("rejeita playerId inválido", () => {
        expect(() => Wallet.open({ id: crypto.randomUUID(), playerId: "com espaço", currency: BRL, now: agora })).toThrow();
    });
});
