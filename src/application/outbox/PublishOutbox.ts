import type { Clock, OutboxMessage, UnitOfWork } from "../ports";

export interface ResultadoDaPublicacao {
    readonly publicados: readonly string[];
    readonly falhas: readonly { readonly id: string; readonly motivo: string }[];
}

// Porta de saída: para onde os eventos vão (na infraestrutura, uma fila SQS FIFO).
// Recebe o lote em ordem e informa, evento a evento, o que foi aceito e o que falhou.
export interface EventPublisher {
    publish(mensagens: readonly OutboxMessage[]): Promise<ResultadoDaPublicacao>;
}

// Publicador do outbox. Os eventos foram gravados na mesma transação SQL da mudança financeira;
// aqui eles saem para a fila, sempre DEPOIS do commit (nunca antes).
//
// Várias instâncias podem rodar ao mesmo tempo: cada uma trava um lote com FOR UPDATE SKIP LOCKED,
// então nenhuma pega os eventos que outra está publicando.
// Entrega "pelo menos uma vez": se a fila aceitar e o commit falhar, o evento sai de novo;
// o eventId vai como MessageDeduplicationId e permite ao consumidor descartar a repetição.
export class PublishOutbox {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly publisher: EventPublisher,
        private readonly clock: Clock,
        private readonly tamanhoDoLote = 100
    ) {}

    /** Publica um lote; devolve quantos eventos foram publicados com sucesso. */
    async execute(): Promise<number> {
        return this.uow.run(async (ctx) => {
            const lote = await ctx.outbox.lockBatch(this.tamanhoDoLote, this.clock());
            if (lote.length === 0) return 0;

            let resultado: ResultadoDaPublicacao;
            try {
                resultado = await this.publisher.publish(lote);
            } catch (erro: unknown) {
                const motivo = erro instanceof Error ? erro.message : String(erro);
                resultado = { publicados: [], falhas: lote.map((m) => ({ id: m.id, motivo })) };
            }

            for (const id of resultado.publicados) await ctx.outbox.markPublished(id);
            const tentativas = new Map(lote.map((m) => [m.id, m.attempts]));
            for (const falha of resultado.falhas) {
                const atraso = Math.min(1000 * 2 ** (tentativas.get(falha.id) ?? 0), 60_000);
                await ctx.outbox.markFailed(falha.id, falha.motivo, new Date(this.clock().getTime() + atraso));
            }
            return resultado.publicados.length;
        });
    }

    async lagSeconds(): Promise<number> {
        return this.uow.run((ctx) => ctx.outbox.oldestPendingAgeSeconds());
    }
}
