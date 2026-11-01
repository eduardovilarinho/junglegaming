import type { LoggerService } from "@nestjs/common";
import { contextoAtual } from "./contexto";

type Nivel = "debug" | "info" | "warn" | "error" | "verbose" | "fatal";

// Logger do Nest em JSON estruturado, uma linha por evento, com os ids do contexto atual
// (correlationId, messageId, transactionId, walletId, providerId).
export class LoggerJson implements LoggerService {
    log(mensagem: unknown, ...extras: unknown[]): void {
        this.escrever("info", mensagem, extras);
    }

    error(mensagem: unknown, ...extras: unknown[]): void {
        this.escrever("error", mensagem, extras);
    }

    warn(mensagem: unknown, ...extras: unknown[]): void {
        this.escrever("warn", mensagem, extras);
    }

    debug(mensagem: unknown, ...extras: unknown[]): void {
        this.escrever("debug", mensagem, extras);
    }

    verbose(mensagem: unknown, ...extras: unknown[]): void {
        this.escrever("verbose", mensagem, extras);
    }

    fatal(mensagem: unknown, ...extras: unknown[]): void {
        this.escrever("fatal", mensagem, extras);
    }

    private escrever(nivel: Nivel, mensagem: unknown, extras: readonly unknown[]): void {
        // O Nest manda o nome do contexto (classe) como último argumento de texto
        const ultimo = extras.at(-1);
        const contexto = typeof ultimo === "string" ? ultimo : undefined;
        const pilha = nivel === "error" || nivel === "fatal" ? extras.find((e) => typeof e === "string" && e.includes("\n    at ")) : undefined;
        const linha = {
            level: nivel,
            time: new Date().toISOString(),
            context: contexto,
            message: mensagem instanceof Error ? mensagem.message : typeof mensagem === "string" ? mensagem : JSON.stringify(mensagem),
            ...contextoAtual(),
            ...(pilha !== undefined && pilha !== contexto ? { stack: pilha } : {}),
        };
        const saida = nivel === "error" || nivel === "fatal" ? process.stderr : process.stdout;
        saida.write(JSON.stringify(linha) + "\n");
    }
}
