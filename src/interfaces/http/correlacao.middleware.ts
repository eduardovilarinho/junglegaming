import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { comContexto, referenciaDoContexto } from "../../infrastructure/observabilidade/contexto";

const ID_VALIDO = /^[A-Za-z0-9._:-]{1,100}$/;

// Dá a cada requisição um correlationId (o recebido em X-Correlation-Id, ou um novo),
// devolve no cabeçalho da resposta e registra uma linha de log ao terminar.
@Injectable()
export class CorrelacaoMiddleware implements NestMiddleware {
    readonly #logger = new Logger("HTTP");

    use(req: Request, res: Response, next: NextFunction): void {
        const recebido = req.header("x-correlation-id");
        const correlationId = recebido !== undefined && ID_VALIDO.test(recebido) ? recebido : crypto.randomUUID();
        res.setHeader("X-Correlation-Id", correlationId);

        comContexto({ correlationId }, () => {
            const inicio = performance.now();
            // O evento "finish" roda fora do contexto assíncrono da requisição: reaplica o contexto
            // (já enriquecido com walletId, transactionId etc.) para o log sair com os ids
            const contexto = referenciaDoContexto() ?? { correlationId };
            res.on("finish", () => {
                comContexto(contexto, () => {
                    this.#logger.log(
                        req.method + " " + req.path + " " + String(res.statusCode) + " " + (performance.now() - inicio).toFixed(1) + "ms"
                    );
                });
            });
            next();
        });
    }
}
