import type { Logger } from "@nestjs/common";

// Executa uma tarefa em intervalos. Se a tarefa disser que ainda há trabalho, roda de novo
// imediatamente (esvazia o backlog); senão espera o intervalo. parar() aguarda a rodada em curso.
export class LoopPeriodico {
    #ativo = false;
    #temporizador: ReturnType<typeof setTimeout> | null = null;
    #emAndamento: Promise<void> | null = null;

    constructor(
        private readonly intervaloMs: number,
        /** Devolve true quando ainda há trabalho pendente */
        private readonly tarefa: () => Promise<boolean>,
        private readonly logger: Logger
    ) {}

    iniciar(): void {
        this.#ativo = true;
        this.agendar(0);
    }

    async parar(): Promise<void> {
        this.#ativo = false;
        if (this.#temporizador !== null) clearTimeout(this.#temporizador);
        await this.#emAndamento;
    }

    private agendar(ms: number): void {
        if (!this.#ativo) return;
        this.#temporizador = setTimeout(() => {
            this.#emAndamento = this.rodar();
        }, ms);
    }

    private async rodar(): Promise<void> {
        let haMais = false;
        try {
            haMais = await this.tarefa();
        } catch (erro: unknown) {
            this.logger.error("Falha na rodada: " + (erro instanceof Error ? erro.message : String(erro)));
        } finally {
            this.#emAndamento = null;
            this.agendar(haMais ? 0 : this.intervaloMs);
        }
    }
}
