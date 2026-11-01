import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { comTempoLimite, type Verificador } from "./Verificador";

// Além de alcançar o SQS, confirma que a fila de transações existe
export class VerificadorSqs implements Verificador {
    readonly nome = "sqs";

    constructor(
        private readonly sqs: SQSClient,
        private readonly fila: string
    ) {}

    verificar(): Promise<void> {
        return comTempoLimite(this.sqs.send(new GetQueueUrlCommand({ QueueName: this.fila })), 2000);
    }
}
