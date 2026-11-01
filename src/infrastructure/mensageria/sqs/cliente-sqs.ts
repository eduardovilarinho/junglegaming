import { SQSClient } from "@aws-sdk/client-sqs";
import type { Configuracao } from "../../config";

// Cria o cliente do SQS. Com endpoint definido, aponta para o MiniStack local;
// sem endpoint, usa a AWS de verdade.
export function criarClienteSqs(config: Configuracao["sqs"]): SQSClient {
    return new SQSClient({
        region: config.regiao,
        ...(config.endpoint !== undefined && { endpoint: config.endpoint }),
        ...(config.credenciais !== null && { credentials: config.credenciais }),
    });
}