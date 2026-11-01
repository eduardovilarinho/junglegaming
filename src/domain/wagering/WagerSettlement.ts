import type { AnyDomainEvent } from "../shared/DomainEvent";
import { InvalidStateTransitionError } from "../shared/errors";
import type { BalanceChange, Wallet } from "../wallet/Wallet";
import type { FailureCode } from "./FailureCode";
import {
    WagerTransactionPendingReference,
    WagerTransactionProcessed,
    WagerTransactionRejected,
} from "./WagerEvents";
import type { TransactionType, WagerTransaction } from "./WagerTransaction";

// Política de novas tentativas para referências ausentes (backoff exponencial com teto)
export interface RetryPolicy {
    /** Quantas novas tentativas o worker faz antes de rejeitar com REFERENCE_NOT_FOUND */
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
}

export function nextRetryAt(politica: RetryPolicy, tentativa: number, agora: Date): Date {
    const atraso = Math.min(politica.baseDelayMs * 2 ** tentativa, politica.maxDelayMs);
    return new Date(agora.getTime() + atraso);
}

// Resultado da busca pela transação referenciada (feita pela aplicação, sob o lock da carteira)
export type ReferenceLookup =
    | { readonly kind: "not-required" }
    | { readonly kind: "missing" }
    | { readonly kind: "found"; readonly transaction: WagerTransaction; readonly alreadyReversed: boolean };

export interface SettlementInput {
    readonly transaction: WagerTransaction;
    readonly wallet: Wallet | null;
    readonly reference: ReferenceLookup;
    readonly now: Date;
    readonly retryPolicy: RetryPolicy;
}

export interface SettlementOutcome {
    /** Mudança de saldo, quando houve (gera exatamente um lançamento) */
    readonly balanceChange: BalanceChange | null;
    /** Transação que este REFUND/ROLLBACK reverteu: vira uma linha em transaction_reversals */
    readonly reversedTransactionId: string | null;
    readonly events: readonly AnyDomainEvent[];
}

type Resolucao =
    | { readonly ok: true; readonly referencia: WagerTransaction | null }
    | { readonly ok: false; readonly outcome: SettlementOutcome };

// Serviço de domínio: aplica as regras de BET, WIN, LOSS, REFUND e ROLLBACK.
// É puro: recebe os agregados já carregados (e travados) e altera só eles.
// A aplicação depois grava tudo numa única transação SQL.
export function settle(input: SettlementInput): SettlementOutcome {
    const t = input.transaction;
    const agora = input.now;
    if (t.isTerminal) {
        throw new InvalidStateTransitionError("A transação " + t.id + " já está " + t.status);
    }

    const carteira = input.wallet;

    const rejeitar = (codigo: FailureCode, referenciaId: string | null = null): SettlementOutcome => {
        // Saldo observado só faz sentido se a carteira é a desta transação (mesmo jogador e moeda)
        const observado =
            carteira !== null && carteira.playerId === t.playerId && carteira.currency.equals(t.amount.currency) ? carteira.balance : null;
        t.reject(codigo, agora, referenciaId, observado);
        return { balanceChange: null, reversedTransactionId: null, events: [new WagerTransactionRejected(t, codigo, agora)] };
    };

    const processar = (
        mudanca: BalanceChange | null,
        referenciaId: string | null,
        revertida: string | null
    ): SettlementOutcome => {
        t.markProcessed(agora, referenciaId, exigirCarteira(carteira).balance);
        const eventos: AnyDomainEvent[] = [new WagerTransactionProcessed(t, agora)];
        if (mudanca !== null) eventos.push(mudanca.event);
        return { balanceChange: mudanca, reversedTransactionId: revertida, events: eventos };
    };

    const aguardar = (): SettlementOutcome => {
        if (t.status === "PENDING_REFERENCE" && t.attempts >= input.retryPolicy.maxAttempts) {
            return rejeitar("REFERENCE_NOT_FOUND");
        }
        const primeiraVez = t.status === "PENDING";
        const tentativa = primeiraVez ? 0 : t.attempts + 1;
        const quando = nextRetryAt(input.retryPolicy, tentativa, agora);
        t.waitForReference(quando);
        const eventos = primeiraVez ? [new WagerTransactionPendingReference(t, quando, agora)] : [];
        return { balanceChange: null, reversedTransactionId: null, events: eventos };
    };

    const resolver = (tiposAceitos: readonly TransactionType[], ehReversao: boolean): Resolucao => {
        const busca = input.reference;
        if (busca.kind === "not-required") return { ok: true, referencia: null };
        // Referência ausente, ou presente mas ainda sem resultado final: espera
        if (busca.kind === "missing" || !busca.transaction.isTerminal) return { ok: false, outcome: aguardar() };

        const ref = busca.transaction;
        if (ref.status !== "PROCESSED") return { ok: false, outcome: rejeitar("REFERENCE_NOT_PROCESSED", ref.id) };
        if (!tiposAceitos.includes(ref.type)) return { ok: false, outcome: rejeitar("INVALID_REFERENCE_TYPE", ref.id) };
        const confere =
            ref.playerId === t.playerId &&
            ref.walletId === t.walletId &&
            ref.roundId === t.roundId &&
            ref.amount.currency.equals(t.amount.currency);
        if (!confere) return { ok: false, outcome: rejeitar("REFERENCE_MISMATCH", ref.id) };
        if (ehReversao) {
            if (!ref.amount.equals(t.amount)) return { ok: false, outcome: rejeitar("REVERSAL_AMOUNT_MISMATCH", ref.id) };
            if (busca.alreadyReversed) return { ok: false, outcome: rejeitar("ALREADY_REVERSED", ref.id) };
        }
        return { ok: true, referencia: ref };
    };

    if (carteira === null) return rejeitar("WALLET_NOT_FOUND");
    if (carteira.playerId !== t.playerId) return rejeitar("WALLET_PLAYER_MISMATCH");
    if (!carteira.currency.equals(t.amount.currency)) return rejeitar("CURRENCY_MISMATCH");

    switch (t.type) {
        case "BET": {
            if (!carteira.canDebit(t.amount)) return rejeitar("INSUFFICIENT_FUNDS");
            return processar(carteira.debit(t.amount, t.id, agora), null, null);
        }
        case "WIN": {
            const r = resolver(["BET"], false);
            if (!r.ok) return r.outcome;
            return processar(carteira.credit(t.amount, t.id, agora), r.referencia?.id ?? null, null);
        }
        case "LOSS": {
            // Registra o resultado sem mexer no saldo: nenhum lançamento é criado
            const r = resolver(["BET"], false);
            if (!r.ok) return r.outcome;
            return processar(null, r.referencia?.id ?? null, null);
        }
        case "REFUND": {
            const r = resolver(["BET"], true);
            if (!r.ok) return r.outcome;
            const ref = exigirReferencia(r.referencia);
            return processar(carteira.credit(t.amount, t.id, agora), ref.id, ref.id);
        }
        case "ROLLBACK": {
            const r = resolver(["BET", "WIN", "REFUND"], true);
            if (!r.ok) return r.outcome;
            const ref = exigirReferencia(r.referencia);
            if (ref.type === "BET") {
                // Desfaz o débito do BET: credita de volta
                return processar(carteira.credit(t.amount, t.id, agora), ref.id, ref.id);
            }
            // Desfaz um crédito (WIN ou REFUND): debita, sem nunca deixar o saldo negativo
            if (!carteira.canDebit(t.amount)) return rejeitar("REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE", ref.id);
            return processar(carteira.debit(t.amount, t.id, agora), ref.id, ref.id);
        }
        case "OPENING":
            throw new InvalidStateTransitionError("OPENING é criada já processada, junto com a carteira");
    }
}

function exigirCarteira(carteira: Wallet | null): Wallet {
    if (carteira === null) throw new InvalidStateTransitionError("Transação processada sem carteira");
    return carteira;
}

function exigirReferencia(ref: WagerTransaction | null): WagerTransaction {
    if (ref === null) throw new InvalidStateTransitionError("Reversão sem referência resolvida");
    return ref;
}
