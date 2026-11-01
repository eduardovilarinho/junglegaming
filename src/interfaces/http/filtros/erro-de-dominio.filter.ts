import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import {
    DuplicateWalletError,
    ErroDeAplicacao,
    IdempotencyConflictError,
    InvalidRequestError,
    NotFoundError,
    ProviderMismatchError,
    TransientInfrastructureError,
    UniqueViolationError,
} from "../../../application/errors";
import {
    AcessoNegadoError,
    ErroDeDominio,
    NaoAutenticadoError,
    RegraDeDominioViolada,
} from "../../../domain/identidade/Erros";

interface Mapeamento {
    readonly status: HttpStatus;
    /** Código estável e legível por máquina */
    readonly error: string;
}

// Tabela de mapeamento erro -> HTTP. Cada classe de problema tem um status próprio:
//   400 INVALID_PAYLOAD           pedido malformado ou fora das regras de formato
//   401 UNAUTHENTICATED           sem token ou token inválido
//   403 FORBIDDEN                 sem permissão (ex.: provider do token diferente do da transação)
//   404 NOT_FOUND                 recurso inexistente
//   409 IDEMPOTENCY_CONFLICT      mesma chave/id externo com conteúdo diferente
//   409 WALLET_ALREADY_EXISTS     carteira duplicada para jogador + moeda
//   422 (corpo da transação)      rejeição de negócio, com failureCode (respondida pelo controller)
//   503 SERVICE_UNAVAILABLE       falha passageira de infraestrutura: tente de novo (Retry-After)
function mapear(erro: ErroDeDominio | ErroDeAplicacao): Mapeamento {
    if (erro instanceof InvalidRequestError || erro instanceof RegraDeDominioViolada) {
        return { status: HttpStatus.BAD_REQUEST, error: "INVALID_PAYLOAD" };
    }
    if (erro instanceof NaoAutenticadoError) return { status: HttpStatus.UNAUTHORIZED, error: "UNAUTHENTICATED" };
    if (erro instanceof AcessoNegadoError || erro instanceof ProviderMismatchError) {
        return { status: HttpStatus.FORBIDDEN, error: "FORBIDDEN" };
    }
    if (erro instanceof NotFoundError) return { status: HttpStatus.NOT_FOUND, error: "NOT_FOUND" };
    if (erro instanceof IdempotencyConflictError) return { status: HttpStatus.CONFLICT, error: "IDEMPOTENCY_CONFLICT" };
    if (erro instanceof DuplicateWalletError) return { status: HttpStatus.CONFLICT, error: "WALLET_ALREADY_EXISTS" };
    if (erro instanceof UniqueViolationError) return { status: HttpStatus.CONFLICT, error: "CONFLICT" };
    if (erro instanceof TransientInfrastructureError) {
        return { status: HttpStatus.SERVICE_UNAVAILABLE, error: "SERVICE_UNAVAILABLE" };
    }
    // Erro de domínio inesperado nesta borda (invariante violada): não é culpa do cliente
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, error: "INTERNAL_ERROR" };
}

/** Erros do próprio Nest/Express (JSON malformado, rota inexistente, corpo grande demais...) */
function mapearHttp(erro: HttpException): Mapeamento {
    const status = erro.getStatus();
    if (status === HttpStatus.BAD_REQUEST) return { status, error: "INVALID_PAYLOAD" };
    if (status === HttpStatus.NOT_FOUND) return { status, error: "NOT_FOUND" };
    if (status === HttpStatus.UNAUTHORIZED) return { status, error: "UNAUTHENTICATED" };
    if (status === HttpStatus.FORBIDDEN) return { status, error: "FORBIDDEN" };
    if (status === HttpStatus.SERVICE_UNAVAILABLE) return { status, error: "SERVICE_UNAVAILABLE" };
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) return { status, error: "PAYLOAD_TOO_LARGE" };
    return { status, error: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR" };
}

// Filtro global: TODA resposta de erro sai no mesmo formato { statusCode, error, message },
// com "error" estável. Erros de domínio e de aplicação são traduzidos pela tabela acima;
// erros do framework mantêm o status; qualquer outra coisa é 500 (e vai para o log com stack).
// O domínio não conhece status codes.
@Catch()
export class ErroDeDominioFilter implements ExceptionFilter<unknown> {
    readonly #logger = new Logger(ErroDeDominioFilter.name);

    catch(erro: unknown, host: ArgumentsHost): void {
        const resposta = host.switchToHttp().getResponse<Response>();
        const { status, error } =
            erro instanceof ErroDeDominio || erro instanceof ErroDeAplicacao
                ? mapear(erro)
                : erro instanceof HttpException
                  ? mapearHttp(erro)
                  : { status: HttpStatus.INTERNAL_SERVER_ERROR, error: "INTERNAL_ERROR" };
        if (status === HttpStatus.SERVICE_UNAVAILABLE) resposta.setHeader("Retry-After", "1");
        if (status >= 500) {
            const e = erro instanceof Error ? erro : new Error(String(erro));
            this.#logger.error(e.name + ": " + e.message, e.stack);
        }
        // Mensagem interna só em 4xx; em 5xx não expomos detalhes da infraestrutura
        const message = status >= 500 ? "Falha temporária, tente novamente" : erro instanceof Error ? erro.message : "Erro";
        resposta.status(status).json({ statusCode: status, error, message });
    }
}
