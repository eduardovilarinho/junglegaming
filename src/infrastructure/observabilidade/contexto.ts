import { AsyncLocalStorage } from "node:async_hooks";

// Identificadores que acompanham todo log de uma requisição HTTP ou mensagem da fila.
// Só ids: nunca payloads financeiros completos nem dados pessoais.
export interface ContextoDeLog {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
}

const armazenamento = new AsyncLocalStorage<ContextoDeLog>();

/** Executa `fn` com um contexto de log próprio (por requisição ou por mensagem) */
export function comContexto<T>(inicial: ContextoDeLog, fn: () => T): T {
    return armazenamento.run({ ...inicial }, fn);
}

/** Acrescenta ids ao contexto atual, à medida que vão sendo conhecidos */
export function enriquecerContexto(dados: ContextoDeLog): void {
    const atual = armazenamento.getStore();
    if (atual !== undefined) Object.assign(atual, dados);
}

/** O próprio objeto do contexto atual (vivo), para reaplicar em callbacks que rodam fora dele */
export function referenciaDoContexto(): ContextoDeLog | undefined {
    return armazenamento.getStore();
}

export function contextoAtual(): ContextoDeLog {
    return { ...(armazenamento.getStore() ?? {}) };
}
