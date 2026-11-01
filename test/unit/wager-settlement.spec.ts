import { describe, expect, it } from "bun:test";
import { RegraDeDominioViolada } from "../../src/domain/identidade/Erros";
import { InvalidStateTransitionError } from "../../src/domain/shared/errors";
import { Currency, Money } from "../../src/domain/shared/Money";
import { settle, type ReferenceLookup, type RetryPolicy } from "../../src/domain/wagering/WagerSettlement";
import { WagerTransaction, type WagerType } from "../../src/domain/wagering/WagerTransaction";
import { Wallet } from "../../src/domain/wallet/Wallet";

const BRL = Currency.of("BRL");
const USD = Currency.of("USD");
const agora = new Date("2026-11-01T12:00:00Z");
const politica: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 };

function carteiraCom(saldo: string, moeda = BRL): Wallet {
    const w = Wallet.open({ id: crypto.randomUUID(), playerId: "player-1", currency: moeda, now: agora });
    if (saldo !== "0") w.credit(Money.fromDecimal(saldo, moeda), "abertura", agora);
    return w;
}

let sequencia = 0;
function transacao(
    w: Wallet,
    tipo: WagerType,
    valor: string,
    extra: { referencia?: string; round?: string; player?: string; moeda?: Currency } = {}
): WagerTransaction {
    sequencia += 1;
    return WagerTransaction.receive({
        providerId: "prov-1",
        externalTransactionId: "ext-" + sequencia,
        type: tipo,
        playerId: extra.player ?? "player-1",
        walletId: w.id,
        roundId: extra.round ?? "round-1",
        amount: Money.fromDecimal(valor, extra.moeda ?? BRL),
        referenceExternalTransactionId: extra.referencia ?? null,
        gameId: null,
        requestHash: "h",
        receivedAt: agora,
    });
}

const semReferencia: ReferenceLookup = { kind: "not-required" };
const achada = (t: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({ kind: "found", transaction: t, alreadyReversed });

function aplicar(t: WagerTransaction, w: Wallet | null, reference: ReferenceLookup = semReferencia) {
    return settle({ transaction: t, wallet: w, reference, now: agora, retryPolicy: politica });
}

/** BET processado, para servir de referência */
function betProcessado(w: Wallet, valor: string, round = "round-1"): WagerTransaction {
    const bet = transacao(w, "BET", valor, { round });
    aplicar(bet, w);
    expect(bet.status).toBe("PROCESSED");
    return bet;
}

const tipos = (r: ReturnType<typeof aplicar>): string[] => r.events.map((e) => e.eventType);

describe("BET", () => {
    it("debita, gera lançamento e eventos de processado e saldo", () => {
        const w = carteiraCom("100.00");
        const bet = transacao(w, "BET", "30.00");
        const r = aplicar(bet, w);
        expect(bet.status).toBe("PROCESSED");
        expect(w.balance.toDecimalString()).toBe("70.00");
        expect(r.balanceChange?.entry.direction).toBe("DEBIT");
        expect(tipos(r)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    });

    it("rejeita com INSUFFICIENT_FUNDS sem mexer no saldo", () => {
        const w = carteiraCom("10.00");
        const bet = transacao(w, "BET", "10.01");
        const r = aplicar(bet, w);
        expect(bet.status).toBe("REJECTED");
        expect(bet.failureCode).toBe("INSUFFICIENT_FUNDS");
        expect(w.balance.toDecimalString()).toBe("10.00");
        expect(r.balanceChange).toBeNull();
        expect(tipos(r)).toEqual(["WagerTransactionRejected"]);
    });

    it("não aceita referência nem valor zero", () => {
        const w = carteiraCom("10.00");
        expect(() => transacao(w, "BET", "1.00", { referencia: "x" })).toThrow(RegraDeDominioViolada);
        expect(() => transacao(w, "BET", "0.00")).toThrow(RegraDeDominioViolada);
    });
});

describe("validações da carteira", () => {
    it("WALLET_NOT_FOUND, WALLET_PLAYER_MISMATCH e CURRENCY_MISMATCH", () => {
        const w = carteiraCom("10.00");
        const t1 = transacao(w, "BET", "1.00");
        aplicar(t1, null);
        expect(t1.failureCode).toBe("WALLET_NOT_FOUND");

        const t2 = transacao(w, "BET", "1.00", { player: "outro" });
        aplicar(t2, w);
        expect(t2.failureCode).toBe("WALLET_PLAYER_MISMATCH");

        const t3 = transacao(w, "BET", "1.00", { moeda: USD });
        aplicar(t3, w);
        expect(t3.failureCode).toBe("CURRENCY_MISMATCH");
        expect(w.balance.toDecimalString()).toBe("10.00");
    });
});

describe("WIN", () => {
    it("credita sem referência", () => {
        const w = carteiraCom("0");
        const win = transacao(w, "WIN", "25.00");
        aplicar(win, w);
        expect(win.status).toBe("PROCESSED");
        expect(w.balance.toDecimalString()).toBe("25.00");
    });

    it("com referência a um BET da mesma rodada, credita e guarda a referência", () => {
        const w = carteiraCom("10.00");
        const bet = betProcessado(w, "10.00");
        const win = transacao(w, "WIN", "40.00", { referencia: bet.externalTransactionId });
        aplicar(win, w, achada(bet));
        expect(win.status).toBe("PROCESSED");
        expect(win.referencedTransactionId).toBe(bet.id);
        expect(w.balance.toDecimalString()).toBe("40.00");
    });

    it("rejeita referência de outra rodada", () => {
        const w = carteiraCom("10.00");
        const bet = betProcessado(w, "10.00", "round-A");
        const win = transacao(w, "WIN", "5.00", { referencia: bet.externalTransactionId, round: "round-B" });
        aplicar(win, w, achada(bet));
        expect(win.failureCode).toBe("REFERENCE_MISMATCH");
    });
});

describe("LOSS", () => {
    it("processa sem lançamento e sem evento de saldo", () => {
        const w = carteiraCom("10.00");
        const bet = betProcessado(w, "10.00");
        const versao = w.version;
        const loss = transacao(w, "LOSS", "0", { referencia: bet.externalTransactionId });
        const r = aplicar(loss, w, achada(bet));
        expect(loss.status).toBe("PROCESSED");
        expect(r.balanceChange).toBeNull();
        expect(w.version).toBe(versao);
        expect(tipos(r)).toEqual(["WagerTransactionProcessed"]);
    });
});

describe("REFUND", () => {
    it("devolve o valor do BET uma única vez", () => {
        const w = carteiraCom("50.00");
        const bet = betProcessado(w, "20.00");
        const refund = transacao(w, "REFUND", "20.00", { referencia: bet.externalTransactionId });
        const r = aplicar(refund, w, achada(bet));
        expect(refund.status).toBe("PROCESSED");
        expect(r.reversedTransactionId).toBe(bet.id);
        expect(w.balance.toDecimalString()).toBe("50.00");

        const segundo = transacao(w, "REFUND", "20.00", { referencia: bet.externalTransactionId });
        aplicar(segundo, w, achada(bet, true));
        expect(segundo.failureCode).toBe("ALREADY_REVERSED");
        expect(w.balance.toDecimalString()).toBe("50.00");
    });

    it("exige o mesmo valor do BET (sem estorno parcial)", () => {
        const w = carteiraCom("50.00");
        const bet = betProcessado(w, "20.00");
        const refund = transacao(w, "REFUND", "10.00", { referencia: bet.externalTransactionId });
        aplicar(refund, w, achada(bet));
        expect(refund.failureCode).toBe("REVERSAL_AMOUNT_MISMATCH");
    });

    it("só reverte BET", () => {
        const w = carteiraCom("0");
        const win = transacao(w, "WIN", "5.00");
        aplicar(win, w);
        const refund = transacao(w, "REFUND", "5.00", { referencia: win.externalTransactionId });
        aplicar(refund, w, achada(win));
        expect(refund.failureCode).toBe("INVALID_REFERENCE_TYPE");
    });

    it("rejeita referência a transação rejeitada", () => {
        const w = carteiraCom("1.00");
        const bet = transacao(w, "BET", "5.00");
        aplicar(bet, w);
        expect(bet.status).toBe("REJECTED");
        const refund = transacao(w, "REFUND", "5.00", { referencia: bet.externalTransactionId });
        aplicar(refund, w, achada(bet));
        expect(refund.failureCode).toBe("REFERENCE_NOT_PROCESSED");
    });

    it("exige referência", () => {
        const w = carteiraCom("0");
        expect(() => transacao(w, "REFUND", "1.00")).toThrow(RegraDeDominioViolada);
        expect(() => transacao(w, "ROLLBACK", "1.00")).toThrow(RegraDeDominioViolada);
    });
});

describe("ROLLBACK", () => {
    it("de BET credita de volta", () => {
        const w = carteiraCom("30.00");
        const bet = betProcessado(w, "30.00");
        const rb = transacao(w, "ROLLBACK", "30.00", { referencia: bet.externalTransactionId });
        aplicar(rb, w, achada(bet));
        expect(rb.status).toBe("PROCESSED");
        expect(w.balance.toDecimalString()).toBe("30.00");
    });

    it("de WIN debita o prêmio", () => {
        const w = carteiraCom("0");
        const win = transacao(w, "WIN", "15.00");
        aplicar(win, w);
        const rb = transacao(w, "ROLLBACK", "15.00", { referencia: win.externalTransactionId });
        aplicar(rb, w, achada(win));
        expect(rb.status).toBe("PROCESSED");
        expect(w.balance.isZero()).toBe(true);
    });

    it("de WIN que deixaria saldo negativo usa um código próprio, diferente de INSUFFICIENT_FUNDS", () => {
        const w = carteiraCom("0");
        const win = transacao(w, "WIN", "15.00");
        aplicar(win, w);
        const bet = transacao(w, "BET", "10.00");
        aplicar(bet, w);
        const rb = transacao(w, "ROLLBACK", "15.00", { referencia: win.externalTransactionId });
        aplicar(rb, w, achada(win));
        expect(rb.failureCode).toBe("REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE");
        expect(w.balance.toDecimalString()).toBe("5.00");
    });

    it("de REFUND debita de novo", () => {
        const w = carteiraCom("20.00");
        const bet = betProcessado(w, "20.00");
        const refund = transacao(w, "REFUND", "20.00", { referencia: bet.externalTransactionId });
        aplicar(refund, w, achada(bet));
        const rb = transacao(w, "ROLLBACK", "20.00", { referencia: refund.externalTransactionId });
        aplicar(rb, w, achada(refund));
        expect(rb.status).toBe("PROCESSED");
        expect(w.balance.isZero()).toBe(true);
    });

    it("não reverte LOSS nem outro ROLLBACK", () => {
        const w = carteiraCom("10.00");
        const bet = betProcessado(w, "10.00");
        const loss = transacao(w, "LOSS", "0", { referencia: bet.externalTransactionId });
        aplicar(loss, w, achada(bet));
        const rb = transacao(w, "ROLLBACK", "1.00", { referencia: loss.externalTransactionId });
        aplicar(rb, w, achada(loss));
        expect(rb.failureCode).toBe("INVALID_REFERENCE_TYPE");
    });
});

describe("referência ausente (fora de ordem)", () => {
    it("fica pendente com backoff e emite o evento só na primeira vez", () => {
        const w = carteiraCom("0");
        const rb = transacao(w, "ROLLBACK", "10.00", { referencia: "ainda-nao-chegou" });
        const r1 = aplicar(rb, w, { kind: "missing" });
        expect(rb.status).toBe("PENDING_REFERENCE");
        expect(rb.nextRetryAt?.getTime()).toBe(agora.getTime() + 1000);
        expect(tipos(r1)).toEqual(["WagerTransactionPendingReference"]);

        const r2 = aplicar(rb, w, { kind: "missing" });
        expect(rb.attempts).toBe(1);
        expect(rb.nextRetryAt?.getTime()).toBe(agora.getTime() + 2000);
        expect(r2.events).toHaveLength(0);
    });

    it("rejeita com REFERENCE_NOT_FOUND depois do limite de tentativas", () => {
        const w = carteiraCom("0");
        const rb = transacao(w, "ROLLBACK", "10.00", { referencia: "nunca" });
        aplicar(rb, w, { kind: "missing" });
        for (let i = 0; i < politica.maxAttempts; i++) aplicar(rb, w, { kind: "missing" });
        expect(rb.status).toBe("PENDING_REFERENCE");
        const r = aplicar(rb, w, { kind: "missing" });
        expect(rb.status).toBe("REJECTED");
        expect(rb.failureCode).toBe("REFERENCE_NOT_FOUND");
        expect(tipos(r)).toEqual(["WagerTransactionRejected"]);
    });

    it("o atraso tem teto", () => {
        const w = carteiraCom("0");
        const rb = transacao(w, "ROLLBACK", "1.00", { referencia: "x" });
        aplicar(rb, w, { kind: "missing" });
        aplicar(rb, w, { kind: "missing" });
        aplicar(rb, w, { kind: "missing" });
        aplicar(rb, w, { kind: "missing" });
        expect(rb.nextRetryAt?.getTime()).toBe(agora.getTime() + 8000);
    });

    it("quando a referência chega, a pendente é aplicada normalmente", () => {
        const w = carteiraCom("10.00");
        const rb = transacao(w, "ROLLBACK", "10.00", { referencia: "bet-tardio" });
        aplicar(rb, w, { kind: "missing" });
        const bet = WagerTransaction.receive({
            providerId: "prov-1", externalTransactionId: "bet-tardio", type: "BET", playerId: "player-1",
            walletId: w.id, roundId: "round-1", amount: Money.fromDecimal("10.00", BRL),
            referenceExternalTransactionId: null, gameId: null, requestHash: "h", receivedAt: agora,
        });
        aplicar(bet, w);
        aplicar(rb, w, achada(bet));
        expect(rb.status).toBe("PROCESSED");
        expect(w.balance.toDecimalString()).toBe("10.00");
    });
});

describe("máquina de estados", () => {
    it("estados terminais não mudam", () => {
        const w = carteiraCom("10.00");
        const bet = betProcessado(w, "1.00");
        expect(() => aplicar(bet, w)).toThrow(InvalidStateTransitionError);
        expect(() => bet.reject("INSUFFICIENT_FUNDS", agora, null, null)).toThrow(InvalidStateTransitionError);
    });
});
