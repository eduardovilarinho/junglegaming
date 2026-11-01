import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Configuracao } from "../infrastructure/config";
import type { Verificador } from "../infrastructure/saude/Verificador";
import { VerificadorPostgres } from "../infrastructure/saude/VerificadorPostgres";
import { VerificadorSqs } from "../infrastructure/saude/VerificadorSqs";
import { HealthController } from "../interfaces/http/controllers/health.controller";
import { CONFIGURACAO, SQS_CLIENT, VERIFICADORES_DE_SAUDE } from "../interfaces/http/tokens";

@Module({
    controllers: [HealthController],
    providers: [
        {
            provide: VERIFICADORES_DE_SAUDE,
            inject: [EntityManager, SQS_CLIENT, CONFIGURACAO],
            useFactory: (em: EntityManager, sqs: SQSClient, config: Configuracao): readonly Verificador[] => [
                new VerificadorPostgres(em),
                new VerificadorSqs(sqs, config.sqs.filaDeTransacoes),
            ],
        },
    ],
})
export class SaudeModule {}
