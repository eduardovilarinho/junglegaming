import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { PublishOutbox } from "../../application/outbox/PublishOutbox";
import type { Configuracao } from "../../infrastructure/config";
import { Metricas } from "../../infrastructure/observabilidade/Metricas";
import { CONFIGURACAO, METRICAS } from "../http/tokens";
import { LoopPeriodico } from "./LoopPeriodico";

// Publica os eventos do outbox no SQS. Roda em todas as instâncias: o SKIP LOCKED
// divide o trabalho entre elas sem publicar o mesmo evento duas vezes.
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    readonly #logger = new Logger(OutboxWorker.name);
    #loop: LoopPeriodico | null = null;

    constructor(
        @Inject(PublishOutbox) private readonly publicar: PublishOutbox,
        @Inject(METRICAS) private readonly metricas: Metricas,
        @Inject(CONFIGURACAO) private readonly config: Configuracao
    ) {}

    onApplicationBootstrap(): void {
        if (!this.config.workers.habilitados) return;
        this.#loop = new LoopPeriodico(
            this.config.workers.intervaloDoOutboxMs,
            async () => {
                const publicados = await this.publicar.execute();
                this.metricas.registrarAtrasoDoOutbox(await this.publicar.lagSeconds());
                return publicados > 0;
            },
            this.#logger
        );
        this.#loop.iniciar();
        this.#logger.log("Publicador do outbox iniciado");
    }

    // Antes do desligamento: termina a rodada em curso enquanto o banco ainda está conectado
    async beforeApplicationShutdown(): Promise<void> {
        await this.#loop?.parar();
    }
}
