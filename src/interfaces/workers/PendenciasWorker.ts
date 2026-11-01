import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { ResumePendingTransactions } from "../../application/wagering/ResumePendingTransactions";
import type { Configuracao } from "../../infrastructure/config";
import { CONFIGURACAO } from "../http/tokens";
import { LoopPeriodico } from "./LoopPeriodico";

const LOTE = 50;

// Tenta de novo as transações que esperam a referência (PENDING_REFERENCE), com backoff.
// Roda em todas as instâncias: o SKIP LOCKED garante que cada pendência é tratada por uma só.
@Injectable()
export class PendenciasWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    readonly #logger = new Logger(PendenciasWorker.name);
    #loop: LoopPeriodico | null = null;

    constructor(
        @Inject(ResumePendingTransactions) private readonly retomar: ResumePendingTransactions,
        @Inject(CONFIGURACAO) private readonly config: Configuracao
    ) {}

    onApplicationBootstrap(): void {
        if (!this.config.workers.habilitados) return;
        this.#loop = new LoopPeriodico(
            this.config.workers.intervaloDePendenciasMs,
            async () => (await this.retomar.execute(LOTE)) === LOTE,
            this.#logger
        );
        this.#loop.iniciar();
        this.#logger.log("Worker de pendências iniciado");
    }

    async beforeApplicationShutdown(): Promise<void> {
        await this.#loop?.parar();
    }
}
