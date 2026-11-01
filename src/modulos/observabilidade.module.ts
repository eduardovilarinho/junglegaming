import { Global, Logger, Module } from "@nestjs/common";
import { Metricas } from "../infrastructure/observabilidade/Metricas";
import { MetricsController } from "../interfaces/http/controllers/metrics.controller";
import { METRICAS } from "../interfaces/http/tokens";

@Global()
@Module({
    controllers: [MetricsController],
    providers: [
        {
            provide: METRICAS,
            useFactory: (): Metricas => {
                const logger = new Logger("Reconciliacao");
                return new Metricas((mensagem) => logger.error(mensagem));
            },
        },
    ],
    exports: [METRICAS],
})
export class ObservabilidadeModule {}
