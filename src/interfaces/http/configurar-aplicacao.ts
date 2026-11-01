import type { INestApplication } from "@nestjs/common";
import { CorrelacaoMiddleware } from "./correlacao.middleware";

/** Middlewares globais e desligamento ordenado; usado pelo main.ts e pelos testes que sobem a aplicação */
export function configurarAplicacao(app: INestApplication): void {
    const correlacao = new CorrelacaoMiddleware();
    app.use(correlacao.use.bind(correlacao));
    app.enableShutdownHooks();
}
