import { RegraDeDominioViolada } from "../identidade/Erros";
import { InvalidStateTransitionError } from "../shared/errors";
import { requireIdentifier, requireUuid } from "../shared/identifiers";
import type { Money } from "../shared/Money";
import type { FailureCode } from "./FailureCode";

export const WAGER_TYPES = ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] as const;
export type WagerType = (typeof WAGER_TYPES)[number];

/** OPENING é interno: o crédito do saldo inicial ao criar a carteira */
export type TransactionType = WagerType | "OPENING";

export const TRANSACTION_STATUSES = ["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const TERMINAIS: ReadonlySet<TransactionStatus> = new Set(["PROCESSED", "REJECTED", "FAILED"]);

export const PROVEDOR_INTERNO = "internal";

export interface WagerTransactionProps {
    readonly id: string;
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly type: TransactionType;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly amount: Money;
    readonly referenceExternalTransactionId: string | null;
    readonly referencedTransactionId: string | null;
    readonly gameId: string | null;
    readonly status: TransactionStatus;
    readonly failureCode: FailureCode | null;
    /** Saldo da carteira observado ao concluir a transação (devolvido também nas repetições) */
    readonly balanceAfter: Money | null;
    readonly requestHash: string;
    readonly attempts: number;
    readonly nextRetryAt: Date | null;
    readonly createdAt: Date;
    readonly processedAt: Date | null;
}

export interface ReceiveWager {
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly type: WagerType;
    readonly playerId: string;
    readonly walletId: string;
    readonly roundId: string;
    readonly amount: Money;
    readonly referenceExternalTransactionId: string | null;
    readonly gameId: string | null;
    readonly requestHash: string;
    readonly receivedAt: Date;
}

// Agregado WagerTransaction com máquina de estados explícita:
//
//   PENDING ──► PROCESSED | REJECTED | FAILED          (terminais)
//      │
//      └────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
//                  ▲      │
//                  └──────┘  (nova tentativa com backoff)
export class WagerTransaction {
    private constructor(private props: WagerTransactionProps) {}

    /** Transação nova vinda de um provider. Valida o formato do pedido. */
    static receive(c: ReceiveWager): WagerTransaction {
        requireIdentifier("providerId", c.providerId, 64);
        requireIdentifier("externalTransactionId", c.externalTransactionId, 128);
        requireIdentifier("playerId", c.playerId, 64);
        requireUuid("walletId", c.walletId);
        requireIdentifier("roundId", c.roundId, 128);
        if (c.gameId !== null) requireIdentifier("gameId", c.gameId, 128);
        if (c.providerId === PROVEDOR_INTERNO) {
            throw new RegraDeDominioViolada('providerId "internal" é reservado');
        }

        if (c.type === "LOSS") {
            // LOSS só registra o resultado; aceita valor zero
        } else if (!c.amount.isPositive()) {
            throw new RegraDeDominioViolada(c.type + " precisa de valor maior que zero");
        }

        const referencia = c.referenceExternalTransactionId;
        if (referencia !== null) {
            requireIdentifier("referenceExternalTransactionId", referencia, 128);
            if (referencia === c.externalTransactionId) {
                throw new RegraDeDominioViolada("Uma transação não pode referenciar a si mesma");
            }
            if (c.type === "BET") throw new RegraDeDominioViolada("BET não aceita referência");
        } else if (c.type === "REFUND" || c.type === "ROLLBACK") {
            throw new RegraDeDominioViolada(c.type + " exige referenceExternalTransactionId");
        }

        return new WagerTransaction({
            id: crypto.randomUUID(),
            providerId: c.providerId,
            externalTransactionId: c.externalTransactionId,
            type: c.type,
            playerId: c.playerId,
            walletId: c.walletId,
            roundId: c.roundId,
            amount: c.amount,
            referenceExternalTransactionId: referencia,
            referencedTransactionId: null,
            gameId: c.gameId,
            status: "PENDING",
            failureCode: null,
            balanceAfter: null,
            requestHash: c.requestHash,
            attempts: 0,
            nextRetryAt: null,
            createdAt: c.receivedAt,
            processedAt: null,
        });
    }

    /** Crédito do saldo inicial de uma carteira nova: já nasce PROCESSED. */
    static opening(params: {
        readonly walletId: string;
        readonly playerId: string;
        readonly amount: Money;
        readonly requestHash: string;
        readonly now: Date;
    }): WagerTransaction {
        return new WagerTransaction({
            id: crypto.randomUUID(),
            providerId: PROVEDOR_INTERNO,
            externalTransactionId: "opening:" + params.walletId,
            type: "OPENING",
            playerId: params.playerId,
            walletId: params.walletId,
            roundId: "opening",
            amount: params.amount,
            referenceExternalTransactionId: null,
            referencedTransactionId: null,
            gameId: null,
            status: "PROCESSED",
            failureCode: null,
            balanceAfter: params.amount,
            requestHash: params.requestHash,
            attempts: 0,
            nextRetryAt: null,
            createdAt: params.now,
            processedAt: params.now,
        });
    }

    /** Reconstrói do banco sem revalidar transições. */
    static rehydrate(props: WagerTransactionProps): WagerTransaction {
        return new WagerTransaction(props);
    }

    get id(): string { return this.props.id; }
    get providerId(): string { return this.props.providerId; }
    get externalTransactionId(): string { return this.props.externalTransactionId; }
    get type(): TransactionType { return this.props.type; }
    get playerId(): string { return this.props.playerId; }
    get walletId(): string { return this.props.walletId; }
    get roundId(): string { return this.props.roundId; }
    get amount(): Money { return this.props.amount; }
    get referenceExternalTransactionId(): string | null { return this.props.referenceExternalTransactionId; }
    get referencedTransactionId(): string | null { return this.props.referencedTransactionId; }
    get gameId(): string | null { return this.props.gameId; }
    get status(): TransactionStatus { return this.props.status; }
    get failureCode(): FailureCode | null { return this.props.failureCode; }
    get balanceAfter(): Money | null { return this.props.balanceAfter; }
    get requestHash(): string { return this.props.requestHash; }
    get attempts(): number { return this.props.attempts; }
    get nextRetryAt(): Date | null { return this.props.nextRetryAt; }
    get createdAt(): Date { return this.props.createdAt; }
    get processedAt(): Date | null { return this.props.processedAt; }

    get isTerminal(): boolean {
        return TERMINAIS.has(this.props.status);
    }

    /** Cópia dos dados para a camada de persistência */
    toProps(): WagerTransactionProps {
        return { ...this.props };
    }

    markProcessed(agora: Date, referencedTransactionId: string | null, saldoDepois: Money): void {
        this.exigirNaoTerminal("processar");
        this.props = {
            ...this.props,
            status: "PROCESSED",
            referencedTransactionId,
            balanceAfter: saldoDepois,
            nextRetryAt: null,
            processedAt: agora,
        };
    }

    /** saldoObservado: saldo da carteira no momento da rejeição (null se a carteira não existe) */
    reject(codigo: FailureCode, agora: Date, referencedTransactionId: string | null, saldoObservado: Money | null): void {
        this.exigirNaoTerminal("rejeitar");
        this.props = {
            ...this.props,
            status: "REJECTED",
            failureCode: codigo,
            referencedTransactionId,
            balanceAfter: saldoObservado,
            nextRetryAt: null,
            processedAt: agora,
        };
    }

    /** Referência ausente: agenda nova tentativa. Cada nova espera conta como uma tentativa. */
    waitForReference(proximaTentativa: Date): void {
        this.exigirNaoTerminal("aguardar referência");
        this.props = {
            ...this.props,
            status: "PENDING_REFERENCE",
            attempts: this.props.status === "PENDING_REFERENCE" ? this.props.attempts + 1 : this.props.attempts,
            nextRetryAt: proximaTentativa,
        };
    }

    fail(codigo: FailureCode, agora: Date): void {
        this.exigirNaoTerminal("falhar");
        this.props = { ...this.props, status: "FAILED", failureCode: codigo, nextRetryAt: null, processedAt: agora };
    }

    private exigirNaoTerminal(acao: string): void {
        if (this.isTerminal) {
            throw new InvalidStateTransitionError(
                "Não é possível " + acao + " a transação " + this.props.id + ": ela já está " + this.props.status
            );
        }
    }
}
