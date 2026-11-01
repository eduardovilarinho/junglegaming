import { GetQueueUrlCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { carregarConfiguracao } from "../../config";
import { criarClienteSqs } from "./cliente-sqs";

// Script de apoio: envia uma transação para a fila, como um provider faria.
//   bun run sqs:send '<JSON da transação>' [messageId]
// O JSON vira o campo "data" do envelope { messageId, type, occurredAt, data }.
// Sem messageId, um novo é gerado. Repita o mesmo messageId para testar a deduplicação pela inbox.
// MessageGroupId = walletId (ordem por carteira); MessageDeduplicationId aleatório, para que a
// deduplicação seja feita pela aplicação (inbox), e não só pelo SQS.
async function executar(): Promise<void> {
    const json = process.argv[2];
    if (json === undefined) throw new Error("Informe o JSON da transação como primeiro argumento");
    const dados: unknown = JSON.parse(json);
    const walletId =
        typeof dados === "object" && dados !== null && "walletId" in dados && typeof dados.walletId === "string" ? dados.walletId : "sem-carteira";
    const envelope = {
        messageId: process.argv[3] ?? crypto.randomUUID(),
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: dados,
    };

    const config = carregarConfiguracao();
    const sqs = criarClienteSqs(config.sqs);
    try {
        const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.filaDeTransacoes }));
        if (QueueUrl === undefined) throw new Error("Fila " + config.sqs.filaDeTransacoes + " não encontrada; rode bun run sqs:setup");
        await sqs.send(
            new SendMessageCommand({
                QueueUrl,
                MessageBody: JSON.stringify(envelope),
                MessageGroupId: walletId,
                MessageDeduplicationId: crypto.randomUUID(),
            })
        );
        console.log("Mensagem enviada: messageId " + envelope.messageId);
    } finally {
        sqs.destroy();
    }
}

executar().catch((erro: unknown) => {
    console.error(erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
});
