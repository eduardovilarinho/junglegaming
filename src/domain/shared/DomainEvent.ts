// Formato de um evento como ele sai para a fila (outbox -> SQS)
export interface EventEnvelope {
    readonly eventId: string;
    readonly eventType: string;
    readonly eventVersion: number;
    readonly aggregateId: string;
    readonly occurredAt: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

// Base abstrata de todo evento de domínio. Cada tipo de evento é uma subclasse.
// O payload carrega dinheiro como string decimal ("10.50"), nunca como Money:
// o evento é um contrato com o mundo externo e precisa ser JSON puro.
export abstract class DomainEvent<P extends Readonly<Record<string, unknown>>> {
    abstract readonly eventType: string;
    readonly eventVersion: number = 1;
    readonly eventId: string;

    protected constructor(
        readonly aggregateId: string,
        readonly occurredAt: Date,
        readonly payload: P,
        eventId?: string
    ) {
        this.eventId = eventId ?? crypto.randomUUID();
    }

    toEnvelope(): EventEnvelope {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            eventVersion: this.eventVersion,
            aggregateId: this.aggregateId,
            occurredAt: this.occurredAt.toISOString(),
            payload: this.payload,
        };
    }
}

export type AnyDomainEvent = DomainEvent<Readonly<Record<string, unknown>>>;
