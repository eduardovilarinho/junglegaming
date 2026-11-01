import { DomainEvent } from "../shared/DomainEvent";
import type { FailureCode } from "./FailureCode";
import type { WagerTransaction } from "./WagerTransaction";

// Dados comuns a todos os eventos de transação. Dinheiro sempre como string decimal.
export interface WagerTransactionEventPayload {
    readonly transactionId: string;
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly type: string;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly currency: string;
    readonly amount: string;
    readonly referenceExternalTransactionId: string | null;
    readonly [chave: string]: unknown;
}

function dadosDaTransacao(t: WagerTransaction): WagerTransactionEventPayload {
    return {
        transactionId: t.id,
        providerId: t.providerId,
        externalTransactionId: t.externalTransactionId,
        type: t.type,
        playerId: t.playerId,
        walletId: t.walletId,
        roundId: t.roundId,
        currency: t.amount.currency.code,
        amount: t.amount.toDecimalString(),
        referenceExternalTransactionId: t.referenceExternalTransactionId,
    };
}

// Qualquer transação aplicada, inclusive LOSS (que não mexe no saldo)
export class WagerTransactionProcessed extends DomainEvent<
    WagerTransactionEventPayload & { readonly balanceAfter: string | null }
> {
    readonly eventType = "WagerTransactionProcessed";

    constructor(t: WagerTransaction, occurredAt: Date) {
        super(t.id, occurredAt, { ...dadosDaTransacao(t), balanceAfter: t.balanceAfter?.toDecimalString() ?? null });
    }
}

// Rejeição de negócio, com o código estável
export class WagerTransactionRejected extends DomainEvent<
    WagerTransactionEventPayload & { readonly failureCode: FailureCode }
> {
    readonly eventType = "WagerTransactionRejected";

    constructor(t: WagerTransaction, failureCode: FailureCode, occurredAt: Date) {
        super(t.id, occurredAt, { ...dadosDaTransacao(t), failureCode });
    }
}

// A referência ainda não chegou; o worker vai tentar de novo a partir de nextRetryAt
export class WagerTransactionPendingReference extends DomainEvent<
    WagerTransactionEventPayload & { readonly nextRetryAt: string }
> {
    readonly eventType = "WagerTransactionPendingReference";

    constructor(t: WagerTransaction, nextRetryAt: Date, occurredAt: Date) {
        super(t.id, occurredAt, { ...dadosDaTransacao(t), nextRetryAt: nextRetryAt.toISOString() });
    }
}
