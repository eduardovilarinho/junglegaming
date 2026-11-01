import type { AnyDomainEvent } from "../domain/shared/DomainEvent";
import type { WagerTransaction } from "../domain/wagering/WagerTransaction";
import type { LedgerEntry } from "../domain/wallet/LedgerEntry";
import type { Wallet } from "../domain/wallet/Wallet";

// Portas de persistência. Cada uma vive dentro de uma transação SQL (TransactionContext),
// então tudo que um caso de uso grava é confirmado junto ou desfeito junto.

export interface WalletRepository {
    /** SELECT ... FOR UPDATE: trava a carteira até o fim da transação (unidade de concorrência) */
    lockById(id: string): Promise<Wallet | null>;
    findById(id: string): Promise<Wallet | null>;
    insert(wallet: Wallet): Promise<void>;
    /** UPDATE condicional à versão lida: se outra transação mudou antes, falha em vez de sobrescrever */
    saveBalance(wallet: Wallet, versaoEsperada: bigint): Promise<void>;
}

export interface LedgerRepository {
    append(entry: LedgerEntry): Promise<void>;
    /** Página em ordem crescente de versão, depois de `depoisDaVersao` */
    page(walletId: string, depoisDaVersao: bigint | null, limite: number): Promise<readonly LedgerEntry[]>;
    /** Saldo recalculado a partir do ledger, em centavos, e quantos lançamentos entraram na soma */
    calculatedBalance(walletId: string): Promise<{ readonly balance: bigint; readonly entries: number }>;
}

export interface WagerTransactionRepository {
    findById(id: string): Promise<WagerTransaction | null>;
    findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
    /** Próxima pendência vencida, com FOR UPDATE SKIP LOCKED: várias instâncias não pegam a mesma */
    lockNextDuePending(agora: Date): Promise<WagerTransaction | null>;
    insert(t: WagerTransaction): Promise<void>;
    update(t: WagerTransaction): Promise<void>;
    isReversed(transactionId: string): Promise<boolean>;
    /** Garantido por PRIMARY KEY no banco: cada transação só pode ser revertida uma vez */
    recordReversal(revertidaId: string, reversaoId: string): Promise<void>;
}

export interface IdempotencyRecord {
    readonly requestHash: string;
    readonly transactionId: string | null;
}

export interface IdempotencyStore {
    /** INSERT ... ON CONFLICT DO NOTHING. Se outra transação está gravando a mesma chave, espera ela terminar. */
    claim(key: string, requestHash: string): Promise<boolean>;
    find(key: string): Promise<IdempotencyRecord | null>;
    attach(key: string, transactionId: string): Promise<void>;
}

export interface InboxStore {
    /** Registra a mensagem; false se ela já tinha sido processada por este consumidor */
    register(consumer: string, messageId: string): Promise<boolean>;
}

export interface OutboxMessage {
    readonly id: string;
    readonly eventType: string;
    readonly aggregateId: string;
    readonly payload: string;
    readonly attempts: number;
}

export interface OutboxStore {
    add(events: readonly AnyDomainEvent[]): Promise<void>;
    /** Lote de eventos não publicados, com FOR UPDATE SKIP LOCKED */
    lockBatch(limite: number, agora: Date): Promise<readonly OutboxMessage[]>;
    markPublished(id: string): Promise<void>;
    markFailed(id: string, erro: string, proximaTentativa: Date): Promise<void>;
    /** Idade, em segundos, do evento mais antigo ainda não publicado (atraso do outbox) */
    oldestPendingAgeSeconds(): Promise<number>;
}

export interface ReconciliationRecord {
    readonly walletId: string;
    readonly storedBalance: bigint;
    readonly calculatedBalance: bigint;
    readonly consistent: boolean;
}

export interface ReconciliationStore {
    record(r: ReconciliationRecord): Promise<void>;
}

export interface TransactionContext {
    readonly wallets: WalletRepository;
    readonly ledger: LedgerRepository;
    readonly transactions: WagerTransactionRepository;
    readonly idempotency: IdempotencyStore;
    readonly inbox: InboxStore;
    readonly outbox: OutboxStore;
    readonly reconciliations: ReconciliationStore;
}

export interface UnitOfWork {
    /** Executa `trabalho` numa única transação SQL: commit no fim, rollback se lançar erro. */
    run<T>(trabalho: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

/** Relógio injetável, para os testes controlarem o tempo */
export type Clock = () => Date;
export const relogioDoSistema: Clock = () => new Date();
