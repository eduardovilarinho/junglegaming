import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Configuracao } from "../../config";

// Cria as filas FIFO e liga a fila de transações à DLQ. Pode rodar várias vezes:
// o SQS devolve a fila existente quando os atributos são os mesmos.
async function criarFila(sqs: SQSClient, nome: string, atributos: Record<string, string>): Promise<string> {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: nome, Attributes: atributos }));
    if (QueueUrl === undefined) throw new Error("O SQS não devolveu a URL da fila " + nome);
    return QueueUrl;
}

export async function criarFilas(sqs: SQSClient, config: Configuracao["sqs"]): Promise<void> {
    const urlDaDlq = await criarFila(sqs, config.filaDeTransacoesDlq, { FifoQueue: "true" });
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urlDaDlq, AttributeNames: ["QueueArn"] }));
    const arnDaDlq = Attributes?.["QueueArn"];
    if (arnDaDlq === undefined) throw new Error("O SQS não devolveu o ARN da DLQ");

    await criarFila(sqs, config.filaDeTransacoes, {
        FifoQueue: "true",
        VisibilityTimeout: String(config.visibilidadeSegundos),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arnDaDlq, maxReceiveCount: config.maximoDeEntregas }),
    });
    await criarFila(sqs, config.filaDeEventos, { FifoQueue: "true" });
}
