// Erros da camada de aplicação. Não carregam status HTTP: o filtro da camada
// de interface decide o código (ver ErroDeDominioFilter).
export abstract class ErroDeAplicacao extends Error {
    constructor(mensagem: string) {
        super(mensagem);
        this.name = new.target.name;
    }
}

/** Mesma Idempotency-Key (ou mesmo externalTransactionId) com conteúdo diferente */
export class IdempotencyConflictError extends ErroDeAplicacao {}

/** Já existe carteira para este jogador nesta moeda */
export class DuplicateWalletError extends ErroDeAplicacao {}

export class NotFoundError extends ErroDeAplicacao {}

/** O provider do token não é o provider da transação */
export class ProviderMismatchError extends ErroDeAplicacao {}

/** Pedido malformado (formato), antes de qualquer regra de negócio */
export class InvalidRequestError extends ErroDeAplicacao {}

/**
 * Falha passageira de infraestrutura (banco fora, lock demorado, deadlock).
 * `retryable` indica que repetir a mesma operação logo em seguida pode dar certo.
 */
export class TransientInfrastructureError extends ErroDeAplicacao {
    constructor(
        mensagem: string,
        readonly retryable: boolean,
        readonly reason: "deadlock" | "serialization" | "lock-timeout" | "concurrent-update" | "unavailable"
    ) {
        super(mensagem);
    }
}

/** Violação de UNIQUE no banco, com o nome da constraint para quem precisar decidir */
export class UniqueViolationError extends ErroDeAplicacao {
    constructor(readonly constraint: string | null) {
        super("Violação de unicidade" + (constraint === null ? "" : " em " + constraint));
    }
}
