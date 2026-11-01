// Schema financeiro. Fica num arquivo próprio para ser usado pela migração do MikroORM
// e pelos testes de integração (que montam um banco limpo antes de rodar).
//
// As garantias que não podem depender só do código estão aqui, no banco:
// - UNIQUE: uma carteira por jogador e moeda; um id externo por provider; uma reversão por transação;
//   um lançamento por carteira e transação; versões da carteira sem repetição.
// - CHECK: saldo, valores e saldos antes/depois nunca negativos; saldo depois = antes ± valor;
//   versão da carteira a partir de 1; tipos e estados válidos.
// - Trigger: o ledger é só de inserção (UPDATE e DELETE falham).

export const SCHEMA_FINANCEIRO_UP: readonly string[] = [
    `create table "wallets" (
        "id" uuid not null,
        "player_id" varchar(64) not null,
        "currency" char(3) not null,
        "balance" bigint not null,
        "version" bigint not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$')
    )`,

    `create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(64) not null,
        "external_transaction_id" varchar(128) not null,
        "type" varchar(16) not null,
        "player_id" varchar(64) not null,
        "wallet_id" uuid not null,
        "round_id" varchar(128) not null,
        "currency" char(3) not null,
        "amount" bigint not null,
        "reference_external_transaction_id" varchar(128),
        "referenced_transaction_id" uuid,
        "game_id" varchar(128),
        "status" varchar(24) not null,
        "failure_code" varchar(64),
        "balance_after" bigint,
        "request_hash" char(64) not null,
        "attempts" integer not null default 0,
        "next_retry_at" timestamptz,
        "created_at" timestamptz not null,
        "processed_at" timestamptz,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_referenced_fk" foreign key ("referenced_transaction_id") references "wager_transactions" ("id"),
        constraint "wager_transactions_amount_non_negative" check ("amount" >= 0),
        constraint "wager_transactions_balance_after_non_negative" check ("balance_after" >= 0),
        constraint "wager_transactions_type_valid" check ("type" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_valid" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_failure_code_when_failed" check (("status" in ('REJECTED', 'FAILED')) = ("failure_code" is not null)),
        constraint "wager_transactions_retry_when_pending" check (("status" = 'PENDING_REFERENCE') = ("next_retry_at" is not null))
    )`,
    `create index "wager_transactions_pending_due_idx" on "wager_transactions" ("next_retry_at") where "status" = 'PENDING_REFERENCE'`,
    `create index "wager_transactions_wallet_idx" on "wager_transactions" ("wallet_id")`,

    `create table "transaction_reversals" (
        "reversed_transaction_id" uuid not null,
        "reversal_transaction_id" uuid not null,
        "created_at" timestamptz not null default now(),
        constraint "transaction_reversals_pkey" primary key ("reversed_transaction_id"),
        constraint "transaction_reversals_reversal_unique" unique ("reversal_transaction_id"),
        constraint "transaction_reversals_reversed_fk" foreign key ("reversed_transaction_id") references "wager_transactions" ("id"),
        constraint "transaction_reversals_reversal_fk" foreign key ("reversal_transaction_id") references "wager_transactions" ("id")
    )`,

    `create table "ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "wallet_version" bigint not null,
        "direction" varchar(6) not null,
        "amount" bigint not null,
        "balance_before" bigint not null,
        "balance_after" bigint not null,
        "currency" char(3) not null,
        "created_at" timestamptz not null,
        constraint "ledger_entries_pkey" primary key ("id"),
        constraint "ledger_entries_wallet_fk" foreign key ("wallet_id") references "wallets" ("id"),
        constraint "ledger_entries_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id"),
        constraint "ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
        constraint "ledger_entries_wallet_version_unique" unique ("wallet_id", "wallet_version"),
        constraint "ledger_entries_direction_valid" check ("direction" in ('CREDIT', 'DEBIT')),
        constraint "ledger_entries_amount_positive" check ("amount" > 0),
        constraint "ledger_entries_balance_before_non_negative" check ("balance_before" >= 0),
        constraint "ledger_entries_balance_after_non_negative" check ("balance_after" >= 0),
        constraint "ledger_entries_balance_arithmetic" check (
            "balance_after" = case when "direction" = 'CREDIT' then "balance_before" + "amount" else "balance_before" - "amount" end
        ),
        constraint "ledger_entries_wallet_version_positive" check ("wallet_version" >= 1)
    )`,
    `create function "ledger_entries_append_only"() returns trigger language plpgsql as $$
    begin
        raise exception 'ledger_entries é somente inserção: % não é permitido', tg_op using errcode = '55000';
    end;
    $$`,
    `create trigger "ledger_entries_no_update_or_delete" before update or delete on "ledger_entries"
        for each row execute function "ledger_entries_append_only"()`,
    `create trigger "ledger_entries_no_truncate" before truncate on "ledger_entries"
        for each statement execute function "ledger_entries_append_only"()`,

    `create table "idempotency_keys" (
        "key" varchar(255) not null,
        "request_hash" char(64) not null,
        "transaction_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "idempotency_keys_pkey" primary key ("key"),
        constraint "idempotency_keys_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id")
    )`,

    `create table "inbox_messages" (
        "consumer" varchar(64) not null,
        "message_id" varchar(128) not null,
        "processed_at" timestamptz not null default now(),
        constraint "inbox_messages_pkey" primary key ("consumer", "message_id")
    )`,

    `create table "outbox_events" (
        "id" uuid not null,
        "event_type" varchar(64) not null,
        "aggregate_id" uuid not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "published_at" timestamptz,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null default now(),
        "last_error" text,
        constraint "outbox_events_pkey" primary key ("id")
    )`,
    `create index "outbox_events_unpublished_idx" on "outbox_events" ("next_attempt_at") where "published_at" is null`,

    `create table "reconciliation_reports" (
        "id" uuid not null default gen_random_uuid(),
        "wallet_id" uuid not null,
        "stored_balance" bigint not null,
        "calculated_balance" bigint not null,
        "consistent" boolean not null,
        "created_at" timestamptz not null default now(),
        constraint "reconciliation_reports_pkey" primary key ("id"),
        constraint "reconciliation_reports_wallet_fk" foreign key ("wallet_id") references "wallets" ("id")
    )`,
];

export const SCHEMA_FINANCEIRO_DOWN: readonly string[] = [
    `drop table if exists "reconciliation_reports"`,
    `drop table if exists "outbox_events"`,
    `drop table if exists "inbox_messages"`,
    `drop table if exists "idempotency_keys"`,
    `drop table if exists "ledger_entries"`,
    `drop function if exists "ledger_entries_append_only"()`,
    `drop table if exists "transaction_reversals"`,
    `drop table if exists "wager_transactions"`,
    `drop table if exists "wallets"`,
];
