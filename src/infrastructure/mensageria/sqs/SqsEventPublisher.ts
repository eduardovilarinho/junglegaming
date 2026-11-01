import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher, ResultadoDaPublicacao } from "../../../application/outbox/PublishOutbox";
import type { OutboxMessage } from "../../../application/ports";

// O SQS aceita até 10 mensagens por SendMessageBatch
const POR_CHAMADA = 10;

// Publica os eventos do outbox numa fila FIFO, em lotes de 10 (uma chamada de rede por lote).
// - MessageGroupId = carteira (quando o evento tem uma): eventos da mesma carteira saem em ordem.
// - MessageDeduplicationId = id do evento: reenvios do mesmo evento são descartados pelo SQS
//   dentro da janela de deduplicação, e o consumidor ainda pode deduplicar pelo eventId.
export class SqsEventPublisher implements EventPublisher {
    #url: string | null = null;

    constructor(
        private readonly sqs: SQSClient,
        private readonly fila: string
    ) {}

    async publish(mensagens: readonly OutboxMessage[]): Promise<ResultadoDaPublicacao> {
        const publicados: string[] = [];
        const falhas: { id: string; motivo: string }[] = [];
        const url = await this.url();
        // Lotes em sequência, para manter a ordem dentro de cada grupo
        for (let i = 0; i < mensagens.length; i += POR_CHAMADA) {
            const parte = mensagens.slice(i, i + POR_CHAMADA);
            try {
                const r = await this.sqs.send(
                    new SendMessageBatchCommand({
                        QueueUrl: url,
                        Entries: parte.map((m) => ({
                            Id: m.id,
                            MessageBody: m.payload,
                            MessageGroupId: grupoDe(m),
                            MessageDeduplicationId: m.id,
                            MessageAttributes: { eventType: { DataType: "String", StringValue: m.eventType } },
                        })),
                    })
                );
                for (const ok of r.Successful ?? []) if (ok.Id !== undefined) publicados.push(ok.Id);
                for (const erro of r.Failed ?? []) {
                    if (erro.Id !== undefined) falhas.push({ id: erro.Id, motivo: (erro.Code ?? "") + " " + (erro.Message ?? "") });
                }
            } catch (erro: unknown) {
                const motivo = erro instanceof Error ? erro.message : String(erro);
                for (const m of parte) falhas.push({ id: m.id, motivo });
            }
        }
        return { publicados, falhas };
    }

    private async url(): Promise<string> {
        if (this.#url !== null) return this.#url;
        const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.fila }));
        if (QueueUrl === undefined) throw new Error("Fila de eventos " + this.fila + " não encontrada");
        this.#url = QueueUrl;
        return QueueUrl;
    }
}

function grupoDe(m: OutboxMessage): string {
    try {
        const envelope: unknown = JSON.parse(m.payload);
        if (typeof envelope === "object" && envelope !== null && "payload" in envelope) {
            const dados = envelope.payload;
            if (typeof dados === "object" && dados !== null && "walletId" in dados && typeof dados.walletId === "string") {
                return dados.walletId;
            }
        }
    } catch {
        // payload sempre é JSON gravado por nós; se não for, cai no agregado
    }
    return m.aggregateId;
}
