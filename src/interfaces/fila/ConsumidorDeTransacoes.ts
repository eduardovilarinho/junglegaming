import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    GetQueueUrlCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
    type Message,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { IdempotencyConflictError, InvalidRequestError } from "../../application/errors";
import { ProcessWagerTransaction } from "../../application/wagering/ProcessWagerTransaction";
import { RegraDeDominioViolada } from "../../domain/identidade/Erros";
import type { Configuracao } from "../../infrastructure/config";
import { comContexto, enriquecerContexto } from "../../infrastructure/observabilidade/contexto";
import { Metricas } from "../../infrastructure/observabilidade/Metricas";
import { lerMensagemDeAposta, type MensagemDeAposta } from "../contratos/pedidos";
import { CONFIGURACAO, METRICAS, SQS_CLIENT } from "../http/tokens";

export const NOME_DO_CONSUMIDOR = "wager-transactions-consumer";

/** Erros que não melhoram tentando de novo: a mensagem vai direto para a DLQ */
function ehPermanente(erro: unknown): boolean {
    return (
        erro instanceof InvalidRequestError ||
        erro instanceof RegraDeDominioViolada ||
        erro instanceof IdempotencyConflictError ||
        erro instanceof SyntaxError
    );
}

const motivoDe = (erro: unknown): string => (erro instanceof Error ? erro.name + ": " + erro.message : String(erro));

// Consumidor da fila wager-transactions.fifo. Usa o MESMO caso de uso do HTTP.
//
// Garantias:
// - mensagem: { messageId, type: "WagerTransactionRequested", occurredAt, data: { ...transação } };
// - inbox (consumidor + messageId do envelope) gravada na mesma transação SQL: reentrega não duplica efeito;
// - ack (DeleteMessage) só depois do commit: se o processo cair antes, a mensagem volta;
// - erro de negócio -> ack (a rejeição já foi gravada); erro passageiro -> volta com backoff;
//   erro permanente -> DLQ; depois de N entregas o próprio SQS move para a DLQ (redrive);
// - desligamento: termina o que está em curso e devolve à fila o que não começou.
@Injectable()
export class ConsumidorDeTransacoes implements OnApplicationBootstrap, BeforeApplicationShutdown {
    readonly #logger = new Logger(ConsumidorDeTransacoes.name);
    readonly #abortar = new AbortController();
    #ativo = false;
    #laco: Promise<void> | null = null;
    #urls: { readonly fila: string; readonly dlq: string } | null = null;

    constructor(
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
        @Inject(ProcessWagerTransaction) private readonly processar: ProcessWagerTransaction,
        @Inject(METRICAS) private readonly metricas: Metricas,
        @Inject(CONFIGURACAO) private readonly config: Configuracao
    ) {}

    onApplicationBootstrap(): void {
        if (!this.config.workers.habilitados) return;
        this.#ativo = true;
        this.#laco = this.lacoPrincipal();
        this.#logger.log("Consumidor da fila " + this.config.sqs.filaDeTransacoes + " iniciado");
    }

    async beforeApplicationShutdown(): Promise<void> {
        this.#ativo = false;
        this.#abortar.abort();
        await this.#laco;
    }

    private async lacoPrincipal(): Promise<void> {
        while (this.#ativo) {
            let mensagens: Message[];
            try {
                const urls = await this.urls();
                const resposta = await this.sqs.send(
                    new ReceiveMessageCommand({
                        QueueUrl: urls.fila,
                        MaxNumberOfMessages: 10,
                        WaitTimeSeconds: 10,
                        VisibilityTimeout: this.config.sqs.visibilidadeSegundos,
                        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
                        MessageAttributeNames: ["All"],
                    }),
                    { abortSignal: this.#abortar.signal }
                );
                mensagens = resposta.Messages ?? [];
            } catch (erro: unknown) {
                if (!this.#ativo) break;
                this.#logger.warn("Falha ao ler a fila: " + motivoDe(erro));
                await Bun.sleep(1000);
                continue;
            }

            // Mesmo MessageGroupId (mesma carteira, por convenção do produtor): em ordem.
            // Grupos diferentes: em paralelo.
            const grupos = new Map<string, Message[]>();
            for (const m of mensagens) {
                const grupo = m.Attributes?.["MessageGroupId"] ?? m.MessageId ?? "";
                grupos.set(grupo, [...(grupos.get(grupo) ?? []), m]);
            }
            await Promise.all(
                [...grupos.values()].map(async (lista) => {
                    for (const m of lista) {
                        if (this.#ativo) await this.tratar(m);
                        else await this.devolver(m);
                    }
                })
            );
        }
        this.#logger.log("Consumidor encerrado");
    }

    private async tratar(m: Message): Promise<void> {
        if (m.MessageId === undefined || m.ReceiptHandle === undefined) return;

        await comContexto({ messageId: m.MessageId }, async () => {
            let mensagem: MensagemDeAposta;
            try {
                mensagem = lerMensagemDeAposta(JSON.parse(m.Body ?? ""));
            } catch (erro: unknown) {
                await this.paraDlq(m, "Mensagem inválida: " + motivoDe(erro));
                return;
            }
            const pedido = mensagem.pedido;
            // A inbox usa o messageId do envelope (definido pelo produtor), não o do SQS:
            // se o produtor reenviar a mesma mensagem, o SQS gera outro MessageId, mas o efeito não se repete
            enriquecerContexto({ messageId: mensagem.messageId, providerId: pedido.providerId, walletId: pedido.walletId });

            try {
                const resultado = await this.processar.execute({
                    command: pedido,
                    idempotencyKey: mensagem.idempotencyKey,
                    inbox: { consumer: NOME_DO_CONSUMIDOR, messageId: mensagem.messageId },
                    origin: "queue",
                });
                if (resultado.kind === "completed") {
                    enriquecerContexto({ transactionId: resultado.transaction.id });
                    this.#logger.log("Mensagem processada: " + resultado.transaction.status + (resultado.replayed ? " (repetida)" : ""));
                } else {
                    this.#logger.log("Mensagem já processada antes (inbox): descartada");
                }

                if (this.config.falhasSimuladas.encerrarDepoisDoCommit) {
                    // SÓ PARA TESTES: simula a queda do processo entre o commit e o ack
                    this.#logger.warn("FAULT_CRASH_AFTER_COMMIT ligado: encerrando antes do ack");
                    process.exit(137);
                }
                await this.confirmar(m);
            } catch (erro: unknown) {
                if (ehPermanente(erro)) {
                    await this.paraDlq(m, motivoDe(erro));
                    return;
                }
                // Passageiro: devolve à fila com backoff exponencial (o redrive leva à DLQ depois de N entregas)
                const entregas = Number(m.Attributes?.["ApproximateReceiveCount"] ?? "1");
                const atraso = Math.min(2 ** entregas, 60);
                this.metricas.retry("queue-transient");
                this.#logger.warn("Falha passageira, nova tentativa em " + atraso + "s: " + motivoDe(erro));
                await this.mudarVisibilidade(m, atraso);
            }
        });
    }

    private async confirmar(m: Message): Promise<void> {
        const urls = await this.urls();
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: urls.fila, ReceiptHandle: m.ReceiptHandle }));
    }

    private async devolver(m: Message): Promise<void> {
        await this.mudarVisibilidade(m, 0);
    }

    private async mudarVisibilidade(m: Message, segundos: number): Promise<void> {
        try {
            const urls = await this.urls();
            await this.sqs.send(
                new ChangeMessageVisibilityCommand({ QueueUrl: urls.fila, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: segundos })
            );
        } catch (erro: unknown) {
            // Sem conseguir mudar a visibilidade, a mensagem volta sozinha quando o tempo dela acabar
            this.#logger.warn("Não foi possível mudar a visibilidade: " + motivoDe(erro));
        }
    }

    private async paraDlq(m: Message, motivo: string): Promise<void> {
        const urls = await this.urls();
        const id = m.MessageId ?? crypto.randomUUID();
        await this.sqs.send(
            new SendMessageCommand({
                QueueUrl: urls.dlq,
                MessageBody: m.Body ?? "",
                MessageGroupId: m.Attributes?.["MessageGroupId"] ?? id,
                MessageDeduplicationId: id,
                MessageAttributes: { failureReason: { DataType: "String", StringValue: motivo.slice(0, 250) } },
            })
        );
        await this.confirmar(m);
        this.metricas.deadLettered();
        this.#logger.warn("Mensagem enviada para a DLQ: " + motivo);
    }

    private async urls(): Promise<{ readonly fila: string; readonly dlq: string }> {
        if (this.#urls !== null) return this.#urls;
        const url = async (nome: string): Promise<string> => {
            const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: nome }));
            if (QueueUrl === undefined) throw new Error("Fila " + nome + " não encontrada");
            return QueueUrl;
        };
        this.#urls = { fila: await url(this.config.sqs.filaDeTransacoes), dlq: await url(this.config.sqs.filaDeTransacoesDlq) };
        return this.#urls;
    }
}
