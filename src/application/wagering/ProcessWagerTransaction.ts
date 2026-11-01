import { settle, type ReferenceLookup, type RetryPolicy, type SettlementOutcome } from "../../domain/wagering/WagerSettlement";
import { WagerTransaction } from "../../domain/wagering/WagerTransaction";
import type { Wallet } from "../../domain/wallet/Wallet";
import { IdempotencyConflictError, UniqueViolationError } from "../errors";
import type { Clock, TransactionContext, UnitOfWork } from "../ports";
import { comRetentativas } from "../retry";
import type { Telemetry } from "../Telemetry";
import { hashDoPedido, paraRecebimento, validarPedido, type WagerCommand } from "./WagerCommand";

export interface ProcessWagerInput {
    readonly command: WagerCommand;
    readonly idempotencyKey: string;
    /** Presente quando o pedido veio da fila: a inbox é gravada na mesma transação SQL */
    readonly inbox?: { readonly consumer: string; readonly messageId: string };
    readonly origin: "http" | "queue";
}

export type ProcessWagerResult =
    | { readonly kind: "completed"; readonly transaction: WagerTransaction; readonly replayed: boolean }
    | { readonly kind: "duplicate-message" };

// Constraints em que perder a corrida significa "outra requisição gravou primeiro":
// basta repetir, e a segunda tentativa encontra o resultado gravado.
const CORRIDAS_ESPERADAS = new Set(["wager_transactions_provider_external_unique", "idempotency_keys_pkey"]);

// Caso de uso central: o mesmo para HTTP e fila.
// Tudo acontece numa transação SQL, nesta ordem:
//  1. inbox (fila): descarta mensagem já processada;
//  2. chave de idempotência: a primeira requisição "reserva" a chave; uma concorrente com a mesma
//     chave espera no índice único até a primeira terminar e então recebe o mesmo resultado;
//  3. lock da carteira (SELECT ... FOR UPDATE): serializa tudo que mexe no mesmo saldo;
//  4. regras de domínio (settle) e gravação de transação, saldo, lançamento, reversão e outbox.
// Eventos só vão para a fila depois do commit, pelo publicador do outbox.
export class ProcessWagerTransaction {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly retryPolicy: RetryPolicy,
        private readonly telemetry: Telemetry,
        private readonly clock: Clock
    ) {}

    async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
        const inicio = performance.now();
        validarPedido(input.command, this.clock());

        const resultado = await comRetentativas(
            () => this.uow.run((ctx) => this.tentar(ctx, input)),
            this.telemetry,
            3,
            (erro) => erro instanceof UniqueViolationError && erro.constraint !== null && CORRIDAS_ESPERADAS.has(erro.constraint)
        );

        if (resultado.kind === "duplicate-message") {
            this.telemetry.duplicateMessage();
        } else if (resultado.replayed) {
            this.telemetry.duplicateRequest(input.origin);
        } else {
            const t = resultado.transaction;
            this.telemetry.transactionSettled(t.type, t.status, performance.now() - inicio);
        }
        return resultado;
    }

    private async tentar(ctx: TransactionContext, input: ProcessWagerInput): Promise<ProcessWagerResult> {
        if (input.inbox !== undefined) {
            const nova = await ctx.inbox.register(input.inbox.consumer, input.inbox.messageId);
            if (!nova) return { kind: "duplicate-message" };
        }

        const hash = hashDoPedido(input.command);
        const reservada = await ctx.idempotency.claim(input.idempotencyKey, hash);
        if (!reservada) return this.repetir(ctx, input.idempotencyKey, hash);

        const jaExiste = await ctx.transactions.findByExternalId(
            input.command.providerId,
            input.command.externalTransactionId
        );
        if (jaExiste !== null) {
            // Mesmo pedido chegando com outra Idempotency-Key: devolve o resultado original
            if (jaExiste.requestHash !== hash) {
                throw new IdempotencyConflictError(
                    "externalTransactionId " + input.command.externalTransactionId + " já foi usado com outro conteúdo"
                );
            }
            await ctx.idempotency.attach(input.idempotencyKey, jaExiste.id);
            return { kind: "completed", transaction: jaExiste, replayed: true };
        }

        const agora = this.clock();
        const transacao = WagerTransaction.receive(paraRecebimento(input.command, hash, agora));
        const carteira = await ctx.wallets.lockById(transacao.walletId);
        const versao = carteira?.version ?? 0n;
        const referencia = await buscarReferencia(ctx, transacao);

        const outcome = settle({ transaction: transacao, wallet: carteira, reference: referencia, now: agora, retryPolicy: this.retryPolicy });

        await ctx.transactions.insert(transacao);
        await gravarEfeitos(ctx, carteira, versao, transacao, outcome);
        await ctx.idempotency.attach(input.idempotencyKey, transacao.id);
        return { kind: "completed", transaction: transacao, replayed: false };
    }

    private async repetir(ctx: TransactionContext, chave: string, hash: string): Promise<ProcessWagerResult> {
        const registro = await ctx.idempotency.find(chave);
        if (registro === null || registro.transactionId === null) {
            // A reserva e o vínculo são gravados na mesma transação: isto não deveria acontecer
            throw new IdempotencyConflictError("Idempotency-Key " + chave + " em estado inconsistente");
        }
        if (registro.requestHash !== hash) {
            throw new IdempotencyConflictError("Idempotency-Key " + chave + " já foi usada com outro conteúdo");
        }
        const original = await ctx.transactions.findById(registro.transactionId);
        if (original === null) throw new IdempotencyConflictError("Transação da Idempotency-Key " + chave + " não encontrada");
        return { kind: "completed", transaction: original, replayed: true };
    }
}

export async function buscarReferencia(ctx: TransactionContext, t: WagerTransaction): Promise<ReferenceLookup> {
    const externa = t.referenceExternalTransactionId;
    if (externa === null) return { kind: "not-required" };
    const ref = await ctx.transactions.findByExternalId(t.providerId, externa);
    if (ref === null) return { kind: "missing" };
    return { kind: "found", transaction: ref, alreadyReversed: await ctx.transactions.isReversed(ref.id) };
}

/** Grava saldo, lançamento, reversão e eventos de um settle já aplicado */
export async function gravarEfeitos(
    ctx: TransactionContext,
    carteira: Wallet | null,
    versaoAntes: bigint,
    transacao: WagerTransaction,
    outcome: SettlementOutcome
): Promise<void> {
    if (outcome.balanceChange !== null && carteira !== null) {
        await ctx.wallets.saveBalance(carteira, versaoAntes);
        await ctx.ledger.append(outcome.balanceChange.entry);
    }
    if (outcome.reversedTransactionId !== null) {
        await ctx.transactions.recordReversal(outcome.reversedTransactionId, transacao.id);
    }
    await ctx.outbox.add(outcome.events);
}
