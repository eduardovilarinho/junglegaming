import "reflect-metadata";
import { readFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { carregarConfiguracao } from "./infrastructure/config";
import { LoggerJson } from "./infrastructure/observabilidade/LoggerJson";
import { configurarAplicacao } from "./interfaces/http/configurar-aplicacao";

async function iniciar(): Promise<void> {
    // O Bun carrega o .env sozinho antes de executar este arquivo
    const config = carregarConfiguracao();
    const logger = new LoggerJson();

    const app = await NestFactory.create(AppModule, {
        logger,
        ...(config.https === null
            ? {}
            : {
                  httpsOptions: {
                      key: readFileSync(config.https.chave),
                      cert: readFileSync(config.https.certificado),
                  },
              }),
    });
    configurarAplicacao(app);

    await app.listen(config.porta);
    const protocolo = config.https === null ? "http" : "https";
    logger.log(
        "Jungle Gaming API em " + protocolo + "://localhost:" + config.porta +
            " (autenticação: " + config.autenticacao.modo + ", workers: " + (config.workers.habilitados ? "ligados" : "desligados") + ")",
        "Main"
    );
}

iniciar().catch((erro: unknown) => {
    console.error("Falha ao iniciar a Jungle Gaming API", erro);
    process.exit(1);
});
