import { InvalidRequestError } from "../../application/errors";
import { chaveDeIdempotenciaPadrao, type WagerCommand } from "../../application/wagering/WagerCommand";
import type { CreateWalletCommand } from "../../application/wallets/CreateWallet";
import { WAGER_TYPES, type WagerType } from "../../domain/wagering/WagerTransaction";

// Leitura dos pedidos que chegam de fora (corpo HTTP ou mensagem da fila).
// Confere só o formato JSON (tipos e campos obrigatórios); as regras de negócio do conteúdo
// (valor, moeda, referência) ficam no domínio.

type Objeto = Readonly<Record<string, unknown>>;

function exigirObjeto(corpo: unknown): Objeto {
    if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
        throw new InvalidRequestError("O corpo deve ser um objeto JSON");
    }
    return corpo as Objeto;
}

function texto(o: Objeto, campo: string): string {
    const v = o[campo];
    if (typeof v !== "string" || v.length === 0) throw new InvalidRequestError('Campo "' + campo + '" é obrigatório e deve ser texto');
    return v;
}

function textoOpcional(o: Objeto, campo: string): string | null {
    const v = o[campo];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length === 0) throw new InvalidRequestError('Campo "' + campo + '" deve ser texto');
    return v;
}

function objeto(o: Objeto, campo: string): Objeto | null {
    const v = o[campo];
    if (v === undefined || v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) throw new InvalidRequestError('Campo "' + campo + '" deve ser um objeto');
    return v as Objeto;
}

/** Dinheiro no formato { "amount": "10.50", "currency": "BRL" }. O valor sempre como string. */
function dinheiro(o: Objeto, campo: string): { readonly amount: string; readonly currency: string } | null {
    const m = objeto(o, campo);
    if (m === null) return null;
    const valor = m["amount"];
    if (typeof valor !== "string") {
        // Número em JSON é ponto flutuante: 0.1 vira 0.1000000000000000055511151231257827
        throw new InvalidRequestError('Campo "' + campo + '.amount" deve ser uma string decimal, ex.: "10.50" (números não são aceitos)');
    }
    return { amount: valor, currency: texto(m, "currency") };
}

function tipoDeAposta(o: Objeto): WagerType {
    const v = texto(o, "kind");
    const tipo = WAGER_TYPES.find((t) => t === v);
    if (tipo === undefined) throw new InvalidRequestError('Campo "kind" deve ser um de: ' + WAGER_TYPES.join(", "));
    return tipo;
}

/**
 * Pedido de transação (corpo do POST /wagering/transactions e campo "data" da mensagem da fila):
 * { providerId, externalTransactionId, playerId, walletId, roundId, gameId?, kind,
 *   money: { amount, currency }, referenceExternalTransactionId? }
 */
export function lerPedidoDeAposta(corpo: unknown): WagerCommand {
    const o = exigirObjeto(corpo);
    const valor = dinheiro(o, "money");
    if (valor === null) throw new InvalidRequestError('Campo "money" é obrigatório');
    return {
        providerId: texto(o, "providerId"),
        externalTransactionId: texto(o, "externalTransactionId"),
        type: tipoDeAposta(o),
        playerId: texto(o, "playerId"),
        walletId: texto(o, "walletId"),
        currency: valor.currency,
        amount: valor.amount,
        roundId: texto(o, "roundId"),
        referenceExternalTransactionId: textoOpcional(o, "referenceExternalTransactionId"),
        gameId: textoOpcional(o, "gameId"),
    };
}

/**
 * Pedido de carteira: { playerId, initialBalance?: { amount, currency } }.
 * Sem saldo inicial, a moeda vem em "currency"; com os dois, eles precisam ser iguais.
 */
export function lerPedidoDeCarteira(corpo: unknown): CreateWalletCommand {
    const o = exigirObjeto(corpo);
    const inicial = dinheiro(o, "initialBalance");
    const moeda = textoOpcional(o, "currency");
    if (inicial !== null && moeda !== null && inicial.currency !== moeda) {
        throw new InvalidRequestError('"currency" e "initialBalance.currency" são diferentes');
    }
    const currency = inicial?.currency ?? moeda;
    if (currency === null) throw new InvalidRequestError('Informe "initialBalance" ou "currency"');
    return { playerId: texto(o, "playerId"), currency, initialBalance: inicial?.amount ?? null };
}

export const TIPO_DA_MENSAGEM = "WagerTransactionRequested";

export interface MensagemDeAposta {
    /** Id definido pelo produtor: é a chave da inbox (reenvio do mesmo messageId não tem efeito) */
    readonly messageId: string;
    readonly occurredAt: Date;
    /** data.idempotencyKey, ou o padrão providerId:externalTransactionId */
    readonly idempotencyKey: string;
    readonly pedido: WagerCommand;
}

/**
 * Mensagem da fila wager-transactions.fifo:
 * { messageId, type: "WagerTransactionRequested", occurredAt, data: { ...pedido, idempotencyKey? } }
 */
export function lerMensagemDeAposta(corpo: unknown): MensagemDeAposta {
    const o = exigirObjeto(corpo);
    const tipo = texto(o, "type");
    if (tipo !== TIPO_DA_MENSAGEM) throw new InvalidRequestError('Campo "type" deve ser ' + TIPO_DA_MENSAGEM);
    const messageId = texto(o, "messageId");
    if (messageId.length > 128) throw new InvalidRequestError('Campo "messageId" deve ter até 128 caracteres');
    const quando = new Date(texto(o, "occurredAt"));
    if (Number.isNaN(quando.getTime())) throw new InvalidRequestError('Campo "occurredAt" deve ser uma data ISO 8601');
    const dados = objeto(o, "data");
    if (dados === null) throw new InvalidRequestError('Campo "data" é obrigatório');
    const pedido = lerPedidoDeAposta(dados);
    const chave = textoOpcional(dados, "idempotencyKey");
    return {
        messageId,
        occurredAt: quando,
        idempotencyKey: chave === null ? chaveDeIdempotenciaPadrao(pedido) : lerChaveDeIdempotencia(chave),
        pedido,
    };
}

/** Idempotency-Key: até 255 caracteres ASCII visíveis */
export function lerChaveDeIdempotencia(valor: string | undefined): string {
    if (valor === undefined || valor.length === 0) {
        throw new InvalidRequestError("O cabeçalho Idempotency-Key é obrigatório");
    }
    if (valor.length > 255 || !/^[\x21-\x7e]+$/.test(valor)) {
        throw new InvalidRequestError("Idempotency-Key deve ter até 255 caracteres ASCII visíveis, sem espaços");
    }
    return valor;
}
