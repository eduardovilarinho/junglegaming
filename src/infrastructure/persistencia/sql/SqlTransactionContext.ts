import type {
    IdempotencyRecord,
    IdempotencyStore,
    InboxStore,
    LedgerRepository,
    OutboxMessage,
    OutboxStore,
    ReconciliationRecord,
    ReconciliationStore,
    TransactionContext,
    WagerTransactionRepository,
    WalletRepository,
} from "../../../application/ports";
import type { AnyDomainEvent } from "../../../domain/shared/DomainEvent";
import { Currency, Money } from "../../../domain/shared/Money";
import { isFailureCode } from "../../../domain/wagering/FailureCode";
import {
    TRANSACTION_STATUSES,
    WagerTransaction,
    type TransactionStatus,
    type TransactionType,
} from "../../../domain/wagering/WagerTransaction";
import { LedgerEntry, type LedgerDirection } from "../../../domain/wallet/LedgerEntry";
import { Wallet } from "../../../domain/wallet/Wallet";
import { TransientInfrastructureError } from "../../../application/errors";
import {
    bigintDe,
    dataDe,
    dataOuNula,
    inteiroDe,
    textoDe,
    textoOuNulo,
    type Linha,
    type SqlExecutor,
} from "./SqlExecutor";

// Repositórios em SQL explícito. Para o núcleo financeiro, SQL explícito deixa visível
// o que garante a correção: FOR UPDATE, SKIP LOCKED, ON CONFLICT e UPDATE condicional.
// Todos usam o mesmo executor, então rodam na mesma transação.

const TIPOS: ReadonlySet<string> = new Set(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]);
const ESTADOS: ReadonlySet<string> = new Set(TRANSACTION_STATUSES);

function tipoDe(l: Linha): TransactionType {
    const v = textoDe(l, "type");
    if (!TIPOS.has(v)) throw new Error("Tipo de transação desconhecido no banco: " + v);
    return v as TransactionType;
}

function estadoDe(l: Linha): TransactionStatus {
    const v = textoDe(l, "status");
    if (!ESTADOS.has(v)) throw new Error("Estado de transação desconhecido no banco: " + v);
    return v as TransactionStatus;
}

function carteiraDe(l: Linha): Wallet {
    const moeda = Currency.of(textoDe(l, "currency"));
    return Wallet.rehydrate({
        id: textoDe(l, "id"),
        playerId: textoDe(l, "player_id"),
        currency: moeda,
        balance: Money.fromMinorUnits(bigintDe(l, "balance"), moeda),
        version: bigintDe(l, "version"),
        createdAt: dataDe(l, "created_at"),
    });
}

function transacaoDe(l: Linha): WagerTransaction {
    const moeda = Currency.of(textoDe(l, "currency"));
    const codigo = textoOuNulo(l, "failure_code");
    const saldoDepois = textoOuNulo(l, "balance_after");
    return WagerTransaction.rehydrate({
        id: textoDe(l, "id"),
        providerId: textoDe(l, "provider_id"),
        externalTransactionId: textoDe(l, "external_transaction_id"),
        type: tipoDe(l),
        playerId: textoDe(l, "player_id"),
        walletId: textoDe(l, "wallet_id"),
        roundId: textoDe(l, "round_id"),
        amount: Money.fromMinorUnits(bigintDe(l, "amount"), moeda),
        referenceExternalTransactionId: textoOuNulo(l, "reference_external_transaction_id"),
        referencedTransactionId: textoOuNulo(l, "referenced_transaction_id"),
        gameId: textoOuNulo(l, "game_id"),
        status: estadoDe(l),
        failureCode: codigo !== null && isFailureCode(codigo) ? codigo : null,
        balanceAfter: saldoDepois === null ? null : Money.fromMinorUnits(BigInt(saldoDepois), moeda),
        requestHash: textoDe(l, "request_hash"),
        attempts: inteiroDe(l, "attempts"),
        nextRetryAt: dataOuNula(l, "next_retry_at"),
        createdAt: dataDe(l, "created_at"),
        processedAt: dataOuNula(l, "processed_at"),
    });
}

function lancamentoDe(l: Linha): LedgerEntry {
    const moeda = Currency.of(textoDe(l, "currency"));
    const direcao = textoDe(l, "direction");
    if (direcao !== "CREDIT" && direcao !== "DEBIT") throw new Error("Direção desconhecida no banco: " + direcao);
    return LedgerEntry.rehydrate({
        id: textoDe(l, "id"),
        walletId: textoDe(l, "wallet_id"),
        transactionId: textoDe(l, "transaction_id"),
        walletVersion: bigintDe(l, "wallet_version"),
        direction: direcao satisfies LedgerDirection,
        amount: Money.fromMinorUnits(bigintDe(l, "amount"), moeda),
        balanceBefore: Money.fromMinorUnits(bigintDe(l, "balance_before"), moeda),
        balanceAfter: Money.fromMinorUnits(bigintDe(l, "balance_after"), moeda),
        createdAt: dataDe(l, "created_at"),
    });
}

const COLUNAS_CARTEIRA = `"id", "player_id", "currency", "balance"::text as "balance", "version"::text as "version", "created_at"`;
const COLUNAS_TRANSACAO = `"id", "provider_id", "external_transaction_id", "type", "player_id", "wallet_id", "round_id",
    "currency", "amount"::text as "amount", "reference_external_transaction_id", "referenced_transaction_id", "game_id",
    "status", "failure_code", "balance_after"::text as "balance_after", "request_hash", "attempts", "next_retry_at", "created_at", "processed_at"`;
const COLUNAS_LANCAMENTO = `"id", "wallet_id", "transaction_id", "wallet_version"::text as "wallet_version", "direction",
    "amount"::text as "amount", "balance_before"::text as "balance_before", "balance_after"::text as "balance_after",
    "currency", "created_at"`;

class SqlWalletRepository implements WalletRepository {
    constructor(private readonly db: SqlExecutor) {}

    async lockById(id: string): Promise<Wallet | null> {
        const [l] = await this.db.query(`select ${COLUNAS_CARTEIRA} from "wallets" where "id" = ? for update`, [id]);
        return l === undefined ? null : carteiraDe(l);
    }

    async findById(id: string): Promise<Wallet | null> {
        const [l] = await this.db.query(`select ${COLUNAS_CARTEIRA} from "wallets" where "id" = ?`, [id]);
        return l === undefined ? null : carteiraDe(l);
    }

    async insert(w: Wallet): Promise<void> {
        await this.db.query(
            `insert into "wallets" ("id", "player_id", "currency", "balance", "version", "created_at", "updated_at")
             values (?, ?, ?, ?, ?, ?, ?)`,
            [w.id, w.playerId, w.currency.code, w.balance.minorUnits.toString(), w.version.toString(), w.createdAt, w.createdAt]
        );
    }

    async saveBalance(w: Wallet, versaoEsperada: bigint): Promise<void> {
        const linhas = await this.db.query(
            `update "wallets" set "balance" = ?, "version" = ?, "updated_at" = now()
             where "id" = ? and "version" = ? returning "id"`,
            [w.balance.minorUnits.toString(), w.version.toString(), w.id, versaoEsperada.toString()]
        );
        if (linhas.length !== 1) {
            // Com o lock da carteira isto não acontece; se acontecer, ninguém sobrescreve o saldo de ninguém
            throw new TransientInfrastructureError("A carteira " + w.id + " mudou durante a operação", true, "concurrent-update");
        }
    }
}

class SqlLedgerRepository implements LedgerRepository {
    constructor(private readonly db: SqlExecutor) {}

    async append(e: LedgerEntry): Promise<void> {
        await this.db.query(
            `insert into "ledger_entries" ("id", "wallet_id", "transaction_id", "wallet_version", "direction", "amount",
                "balance_before", "balance_after", "currency", "created_at")
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                e.id, e.walletId, e.transactionId, e.walletVersion.toString(), e.direction, e.amount.minorUnits.toString(),
                e.balanceBefore.minorUnits.toString(), e.balanceAfter.minorUnits.toString(), e.amount.currency.code, e.createdAt,
            ]
        );
    }

    async page(walletId: string, depoisDaVersao: bigint | null, limite: number): Promise<readonly LedgerEntry[]> {
        const linhas = await this.db.query(
            `select ${COLUNAS_LANCAMENTO} from "ledger_entries"
             where "wallet_id" = ? and "wallet_version" > ? order by "wallet_version" asc limit ?`,
            [walletId, (depoisDaVersao ?? 0n).toString(), limite]
        );
        return linhas.map(lancamentoDe);
    }

    async calculatedBalance(walletId: string): Promise<{ readonly balance: bigint; readonly entries: number }> {
        const [l] = await this.db.query(
            `select coalesce(sum(case when "direction" = 'CREDIT' then "amount" else -"amount" end), 0)::text as "total",
                    count(*)::int as "lancamentos"
             from "ledger_entries" where "wallet_id" = ?`,
            [walletId]
        );
        return l === undefined ? { balance: 0n, entries: 0 } : { balance: bigintDe(l, "total"), entries: inteiroDe(l, "lancamentos") };
    }
}

class SqlWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly db: SqlExecutor) {}

    async findById(id: string): Promise<WagerTransaction | null> {
        const [l] = await this.db.query(`select ${COLUNAS_TRANSACAO} from "wager_transactions" where "id" = ?`, [id]);
        return l === undefined ? null : transacaoDe(l);
    }

    async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
        const [l] = await this.db.query(
            `select ${COLUNAS_TRANSACAO} from "wager_transactions" where "provider_id" = ? and "external_transaction_id" = ?`,
            [providerId, externalTransactionId]
        );
        return l === undefined ? null : transacaoDe(l);
    }

    async lockNextDuePending(agora: Date): Promise<WagerTransaction | null> {
        const [l] = await this.db.query(
            `select ${COLUNAS_TRANSACAO} from "wager_transactions"
             where "status" = 'PENDING_REFERENCE' and "next_retry_at" <= ?
             order by "next_retry_at" asc limit 1
             for update skip locked`,
            [agora]
        );
        return l === undefined ? null : transacaoDe(l);
    }

    async insert(t: WagerTransaction): Promise<void> {
        const p = t.toProps();
        await this.db.query(
            `insert into "wager_transactions" ("id", "provider_id", "external_transaction_id", "type", "player_id", "wallet_id",
                "round_id", "currency", "amount", "reference_external_transaction_id", "referenced_transaction_id", "game_id",
                "status", "failure_code", "balance_after", "request_hash", "attempts", "next_retry_at", "created_at", "processed_at")
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                p.id, p.providerId, p.externalTransactionId, p.type, p.playerId, p.walletId, p.roundId,
                p.amount.currency.code, p.amount.minorUnits.toString(), p.referenceExternalTransactionId,
                p.referencedTransactionId, p.gameId, p.status, p.failureCode, p.balanceAfter?.minorUnits.toString() ?? null,
                p.requestHash, p.attempts,
                p.nextRetryAt, p.createdAt, p.processedAt,
            ]
        );
    }

    async update(t: WagerTransaction): Promise<void> {
        const p = t.toProps();
        await this.db.query(
            `update "wager_transactions" set "status" = ?, "failure_code" = ?, "referenced_transaction_id" = ?,
                "balance_after" = ?, "attempts" = ?, "next_retry_at" = ?, "processed_at" = ?
             where "id" = ?`,
            [
                p.status, p.failureCode, p.referencedTransactionId, p.balanceAfter?.minorUnits.toString() ?? null,
                p.attempts, p.nextRetryAt, p.processedAt, p.id,
            ]
        );
    }

    async isReversed(transactionId: string): Promise<boolean> {
        const linhas = await this.db.query(
            `select 1 as "existe" from "transaction_reversals" where "reversed_transaction_id" = ?`,
            [transactionId]
        );
        return linhas.length > 0;
    }

    async recordReversal(revertidaId: string, reversaoId: string): Promise<void> {
        await this.db.query(
            `insert into "transaction_reversals" ("reversed_transaction_id", "reversal_transaction_id") values (?, ?)`,
            [revertidaId, reversaoId]
        );
    }
}

class SqlIdempotencyStore implements IdempotencyStore {
    constructor(private readonly db: SqlExecutor) {}

    async claim(key: string, requestHash: string): Promise<boolean> {
        const linhas = await this.db.query(
            `insert into "idempotency_keys" ("key", "request_hash") values (?, ?)
             on conflict ("key") do nothing returning "key"`,
            [key, requestHash]
        );
        return linhas.length === 1;
    }

    async find(key: string): Promise<IdempotencyRecord | null> {
        const [l] = await this.db.query(
            `select "request_hash", "transaction_id" from "idempotency_keys" where "key" = ?`,
            [key]
        );
        return l === undefined ? null : { requestHash: textoDe(l, "request_hash"), transactionId: textoOuNulo(l, "transaction_id") };
    }

    async attach(key: string, transactionId: string): Promise<void> {
        await this.db.query(`update "idempotency_keys" set "transaction_id" = ? where "key" = ?`, [transactionId, key]);
    }
}

class SqlInboxStore implements InboxStore {
    constructor(private readonly db: SqlExecutor) {}

    async register(consumer: string, messageId: string): Promise<boolean> {
        const linhas = await this.db.query(
            `insert into "inbox_messages" ("consumer", "message_id") values (?, ?)
             on conflict ("consumer", "message_id") do nothing returning "message_id"`,
            [consumer, messageId]
        );
        return linhas.length === 1;
    }
}

class SqlOutboxStore implements OutboxStore {
    constructor(private readonly db: SqlExecutor) {}

    async add(eventos: readonly AnyDomainEvent[]): Promise<void> {
        for (const e of eventos) {
            await this.db.query(
                `insert into "outbox_events" ("id", "event_type", "aggregate_id", "payload", "occurred_at")
                 values (?, ?, ?, ?::text::jsonb, ?)`,
                [e.eventId, e.eventType, e.aggregateId, JSON.stringify(e.toEnvelope()), e.occurredAt]
            );
        }
    }

    async lockBatch(limite: number, agora: Date): Promise<readonly OutboxMessage[]> {
        const linhas = await this.db.query(
            `select "id", "event_type", "aggregate_id", "payload"::text as "payload", "attempts" from "outbox_events"
             where "published_at" is null and "next_attempt_at" <= ?
             order by "occurred_at" asc, "id" asc limit ?
             for update skip locked`,
            [agora, limite]
        );
        return linhas.map((l) => ({
            id: textoDe(l, "id"),
            eventType: textoDe(l, "event_type"),
            aggregateId: textoDe(l, "aggregate_id"),
            payload: textoDe(l, "payload"),
            attempts: inteiroDe(l, "attempts"),
        }));
    }

    async markPublished(id: string): Promise<void> {
        await this.db.query(`update "outbox_events" set "published_at" = now() where "id" = ?`, [id]);
    }

    async markFailed(id: string, erro: string, proximaTentativa: Date): Promise<void> {
        await this.db.query(
            `update "outbox_events" set "attempts" = "attempts" + 1, "last_error" = ?, "next_attempt_at" = ? where "id" = ?`,
            [erro.slice(0, 2000), proximaTentativa, id]
        );
    }

    async oldestPendingAgeSeconds(): Promise<number> {
        const [l] = await this.db.query(
            `select coalesce(extract(epoch from (now() - min("occurred_at"))), 0)::text as "idade"
             from "outbox_events" where "published_at" is null`
        );
        return l === undefined ? 0 : Number(textoDe(l, "idade"));
    }
}

class SqlReconciliationStore implements ReconciliationStore {
    constructor(private readonly db: SqlExecutor) {}

    async record(r: ReconciliationRecord): Promise<void> {
        await this.db.query(
            `insert into "reconciliation_reports" ("wallet_id", "stored_balance", "calculated_balance", "consistent")
             values (?, ?, ?, ?)`,
            [r.walletId, r.storedBalance.toString(), r.calculatedBalance.toString(), r.consistent]
        );
    }
}

/** Monta todos os repositórios sobre o executor da transação atual */
export function criarContextoSql(db: SqlExecutor): TransactionContext {
    return {
        wallets: new SqlWalletRepository(db),
        ledger: new SqlLedgerRepository(db),
        transactions: new SqlWagerTransactionRepository(db),
        idempotency: new SqlIdempotencyStore(db),
        inbox: new SqlInboxStore(db),
        outbox: new SqlOutboxStore(db),
        reconciliations: new SqlReconciliationStore(db),
    };
}
