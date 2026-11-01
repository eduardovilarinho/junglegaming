import { Module } from "@nestjs/common";
import { ConsumidorDeTransacoes } from "../interfaces/fila/ConsumidorDeTransacoes";
import { OutboxWorker } from "../interfaces/workers/OutboxWorker";
import { PendenciasWorker } from "../interfaces/workers/PendenciasWorker";
import { FinanceiroModule } from "./financeiro.module";

// Processamento assíncrono: consumidor da fila, publicador do outbox e worker de pendências.
// Só começam a rodar com WORKERS_ENABLED=true; podem rodar em quantas instâncias quiser.
@Module({
    imports: [FinanceiroModule],
    providers: [ConsumidorDeTransacoes, OutboxWorker, PendenciasWorker],
})
export class WorkersModule {}
