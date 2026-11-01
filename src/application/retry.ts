import { TransientInfrastructureError } from "./errors";
import type { Telemetry } from "./Telemetry";

// Repete a operação quando o banco devolve um conflito passageiro (deadlock, serialização,
// UPDATE condicional que perdeu a corrida). Tentativas limitadas: depois disso, o erro sobe
// e a borda responde 503 (HTTP) ou devolve a mensagem para a fila (SQS).
export async function comRetentativas<T>(
    operacao: () => Promise<T>,
    telemetria: Telemetry,
    maximo = 3,
    repetirTambem: (erro: unknown) => boolean = () => false
): Promise<T> {
    for (let tentativa = 1; ; tentativa++) {
        try {
            return await operacao();
        } catch (erro: unknown) {
            const passageiro = erro instanceof TransientInfrastructureError && erro.retryable;
            if (erro instanceof TransientInfrastructureError && erro.reason === "lock-timeout") telemetria.lockConflict();
            if (tentativa >= maximo || !(passageiro || repetirTambem(erro))) throw erro;
            telemetria.retry(erro instanceof TransientInfrastructureError ? erro.reason : "unique-race");
            await new Promise((resolver) => setTimeout(resolver, Math.floor(Math.random() * 25 * tentativa)));
        }
    }
}
