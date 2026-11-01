import { DomainEvent } from "../shared/DomainEvent";

export interface WalletBalanceChangedPayload {
    readonly walletId: string;
    readonly playerId: string;
    readonly transactionId: string;
    readonly currency: string;
    readonly previousBalance: string;
    readonly newBalance: string;
    readonly walletVersion: string;
    readonly [chave: string]: unknown;
}

// Publicado só quando o saldo muda de fato (LOSS e rejeições não geram este evento)
export class WalletBalanceChanged extends DomainEvent<WalletBalanceChangedPayload> {
    readonly eventType = "WalletBalanceChanged";

    constructor(payload: WalletBalanceChangedPayload, occurredAt: Date) {
        super(payload.walletId, occurredAt, payload);
    }
}
