import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import { PublishOutbox, type EventPublisher } from "../application/outbox/PublishOutbox";
import { relogioDoSistema, type Clock, type UnitOfWork } from "../application/ports";
import { GetWagerTransaction } from "../application/wagering/GetWagerTransaction";
import { ProcessWagerTransaction } from "../application/wagering/ProcessWagerTransaction";
import { ResumePendingTransactions } from "../application/wagering/ResumePendingTransactions";
import { CreateWallet } from "../application/wallets/CreateWallet";
import { QueryWallets } from "../application/wallets/QueryWallets";
import { ReconcileWallet } from "../application/wallets/ReconcileWallet";
import type { Configuracao } from "../infrastructure/config";
import { SqsEventPublisher } from "../infrastructure/mensageria/sqs/SqsEventPublisher";
import { Metricas } from "../infrastructure/observabilidade/Metricas";
import { MikroOrmUnitOfWork } from "../infrastructure/persistencia/mikro-orm/MikroOrmUnitOfWork";
import { WageringController } from "../interfaces/http/controllers/wagering.controller";
import { WalletsController } from "../interfaces/http/controllers/wallets.controller";
import { CONFIGURACAO, METRICAS, PUBLICADOR_DE_EVENTOS, RELOGIO, SQS_CLIENT, UNIDADE_DE_TRABALHO } from "../interfaces/http/tokens";

// Bounded context financeiro: carteiras, ledger e transações de aposta.
// Os casos de uso são classes puras; aqui eles recebem as implementações concretas das portas.
@Module({
    controllers: [WalletsController, WageringController],
    providers: [
        {
            provide: UNIDADE_DE_TRABALHO,
            inject: [EntityManager, CONFIGURACAO],
            useFactory: (em: EntityManager, config: Configuracao): UnitOfWork =>
                new MikroOrmUnitOfWork(em, config.financeiro.lockTimeoutMs),
        },
        { provide: RELOGIO, useValue: relogioDoSistema },
        {
            provide: ProcessWagerTransaction,
            inject: [UNIDADE_DE_TRABALHO, CONFIGURACAO, METRICAS, RELOGIO],
            useFactory: (uow: UnitOfWork, config: Configuracao, metricas: Metricas, relogio: Clock): ProcessWagerTransaction =>
                new ProcessWagerTransaction(uow, config.financeiro.pendencias, metricas, relogio),
        },
        {
            provide: ResumePendingTransactions,
            inject: [UNIDADE_DE_TRABALHO, CONFIGURACAO, METRICAS, RELOGIO],
            useFactory: (uow: UnitOfWork, config: Configuracao, metricas: Metricas, relogio: Clock): ResumePendingTransactions =>
                new ResumePendingTransactions(uow, config.financeiro.pendencias, metricas, relogio),
        },
        {
            provide: GetWagerTransaction,
            inject: [UNIDADE_DE_TRABALHO],
            useFactory: (uow: UnitOfWork): GetWagerTransaction => new GetWagerTransaction(uow),
        },
        {
            provide: CreateWallet,
            inject: [UNIDADE_DE_TRABALHO, RELOGIO],
            useFactory: (uow: UnitOfWork, relogio: Clock): CreateWallet => new CreateWallet(uow, relogio),
        },
        {
            provide: QueryWallets,
            inject: [UNIDADE_DE_TRABALHO],
            useFactory: (uow: UnitOfWork): QueryWallets => new QueryWallets(uow),
        },
        {
            provide: ReconcileWallet,
            inject: [UNIDADE_DE_TRABALHO, METRICAS],
            useFactory: (uow: UnitOfWork, metricas: Metricas): ReconcileWallet => new ReconcileWallet(uow, metricas),
        },
        {
            provide: PUBLICADOR_DE_EVENTOS,
            inject: [SQS_CLIENT, CONFIGURACAO],
            useFactory: (sqs: SQSClient, config: Configuracao): EventPublisher => new SqsEventPublisher(sqs, config.sqs.filaDeEventos),
        },
        {
            provide: PublishOutbox,
            inject: [UNIDADE_DE_TRABALHO, PUBLICADOR_DE_EVENTOS, RELOGIO],
            useFactory: (uow: UnitOfWork, publicador: EventPublisher, relogio: Clock): PublishOutbox =>
                new PublishOutbox(uow, publicador, relogio),
        },
    ],
    exports: [UNIDADE_DE_TRABALHO, ProcessWagerTransaction, ResumePendingTransactions, PublishOutbox],
})
export class FinanceiroModule {}
