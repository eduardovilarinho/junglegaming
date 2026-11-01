import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Configuracao } from "../infrastructure/config";
import { criarClienteSqs } from "../infrastructure/mensageria/sqs/cliente-sqs";
import { CONFIGURACAO, SQS_CLIENT } from "../interfaces/http/tokens";

// Um único cliente SQS para a aplicação inteira, fechado no desligamento
@Global()
@Module({
    providers: [
        {
            provide: SQS_CLIENT,
            inject: [CONFIGURACAO],
            useFactory: (config: Configuracao): SQSClient => criarClienteSqs(config.sqs),
        },
    ],
    exports: [SQS_CLIENT],
})
export class MensageriaModule implements OnApplicationShutdown {
    constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

    onApplicationShutdown(): void {
        this.sqs.destroy();
    }
}
