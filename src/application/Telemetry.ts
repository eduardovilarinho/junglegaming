import type { TransactionStatus, TransactionType } from "../domain/wagering/WagerTransaction";

// Porta de observabilidade: a aplicação diz O QUE aconteceu; a infraestrutura
// decide como vira métrica e log (ver infrastructure/observabilidade).
export interface Telemetry {
    transactionSettled(tipo: TransactionType, status: TransactionStatus, latenciaMs: number): void;
    duplicateRequest(origem: "http" | "queue"): void;
    duplicateMessage(): void;
    retry(motivo: string): void;
    lockConflict(): void;
    deadLettered(): void;
    reconciliationDivergence(walletId: string, armazenado: string, calculado: string): void;
}

export const telemetriaVazia: Telemetry = {
    transactionSettled: () => undefined,
    duplicateRequest: () => undefined,
    duplicateMessage: () => undefined,
    retry: () => undefined,
    lockConflict: () => undefined,
    deadLettered: () => undefined,
    reconciliationDivergence: () => undefined,
};
