import { createHash } from "node:crypto";
import { Currency, Money } from "../../domain/shared/Money";
import { WagerTransaction, type ReceiveWager, type WagerType } from "../../domain/wagering/WagerTransaction";

// O pedido de transação como chega de fora (HTTP ou fila), já com os tipos básicos conferidos.
export interface WagerCommand {
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly type: WagerType;
    readonly playerId: string;
    readonly walletId: string;
    readonly currency: string;
    readonly amount: string;
    readonly roundId: string;
    readonly referenceExternalTransactionId: string | null;
    readonly gameId: string | null;
}

/** Converte para o formato do domínio; as validações de negócio do formato ficam no agregado. */
export function paraRecebimento(c: WagerCommand, requestHash: string, agora: Date): ReceiveWager {
    return {
        providerId: c.providerId,
        externalTransactionId: c.externalTransactionId,
        type: c.type,
        playerId: c.playerId,
        walletId: c.walletId,
        roundId: c.roundId,
        amount: Money.fromDecimal(c.amount, Currency.of(c.currency)),
        referenceExternalTransactionId: c.referenceExternalTransactionId,
        gameId: c.gameId,
        requestHash,
        receivedAt: agora,
    };
}

/** Valida o pedido inteiro sem tocar no banco: erros de formato saem antes de qualquer efeito. */
export function validarPedido(c: WagerCommand, agora: Date): void {
    WagerTransaction.receive(paraRecebimento(c, hashDoPedido(c), agora));
}

// JSON canônico: chaves em ordem alfabética, sem espaços, valor monetário normalizado.
// Assim "10.5" e "10.50", ou os mesmos campos em outra ordem, geram o mesmo hash.
function jsonCanonico(valor: unknown): string {
    if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
    if (Array.isArray(valor)) return "[" + valor.map(jsonCanonico).join(",") + "]";
    const chaves = Object.keys(valor).sort();
    const objeto = valor as Readonly<Record<string, unknown>>;
    return "{" + chaves.map((k) => JSON.stringify(k) + ":" + jsonCanonico(objeto[k])).join(",") + "}";
}

/** Hash SHA-256 dos campos de negócio do pedido */
export function hashDoPedido(c: WagerCommand): string {
    const campos = {
        providerId: c.providerId,
        externalTransactionId: c.externalTransactionId,
        type: c.type,
        playerId: c.playerId,
        walletId: c.walletId,
        currency: c.currency,
        amount: Money.fromDecimal(c.amount, Currency.of(c.currency)).toDecimalString(),
        roundId: c.roundId,
        referenceExternalTransactionId: c.referenceExternalTransactionId,
        gameId: c.gameId,
    };
    return createHash("sha256").update(jsonCanonico(campos)).digest("hex");
}

/** Chave padrão quando o pedido não traz uma (fila): provider + id externo */
export function chaveDeIdempotenciaPadrao(c: WagerCommand): string {
    return c.providerId + ":" + c.externalTransactionId;
}
