// Taxonomia de falhas: códigos estáveis, legíveis por máquina.
// Uma vez publicados, os códigos não mudam de nome: clientes dependem deles.
export const FailureCodes = {
    INSUFFICIENT_FUNDS: "Saldo insuficiente para o BET.",
    REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE:
        "O estorno (ROLLBACK de WIN ou de REFUND) deixaria o saldo negativo. Diferente de INSUFFICIENT_FUNDS de propósito: não é uma aposta recusada, é uma reversão impossível.",
    WALLET_NOT_FOUND: "A carteira informada não existe.",
    WALLET_PLAYER_MISMATCH: "A carteira pertence a outro jogador.",
    CURRENCY_MISMATCH: "A moeda da transação é diferente da moeda da carteira.",
    REFERENCE_NOT_FOUND:
        "A transação referenciada não apareceu dentro do limite de tentativas do worker de pendências.",
    REFERENCE_MISMATCH:
        "A transação referenciada é de outro jogador, carteira, moeda ou rodada.",
    REFERENCE_NOT_PROCESSED: "A transação referenciada foi rejeitada ou falhou, então não pode ser referenciada.",
    INVALID_REFERENCE_TYPE:
        "O tipo da transação referenciada não é aceito (ex.: REFUND de algo que não é BET, ROLLBACK de LOSS).",
    REVERSAL_AMOUNT_MISMATCH: "O valor do REFUND/ROLLBACK é diferente do valor da transação referenciada.",
    ALREADY_REVERSED: "A transação referenciada já foi revertida (REFUND ou ROLLBACK só valem uma vez).",
    PERMANENT_PROCESSING_ERROR: "Erro permanente no processamento; a mensagem foi para a DLQ.",
} as const;

export type FailureCode = keyof typeof FailureCodes;

export function isFailureCode(valor: string): valor is FailureCode {
    return Object.hasOwn(FailureCodes, valor);
}
