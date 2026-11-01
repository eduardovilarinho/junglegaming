import type { SQL } from "bun";
import type { UnitOfWork } from "../../src/application/ports";
import { telemetriaVazia, type Telemetry } from "../../src/application/Telemetry";
import { ProcessWagerTransaction, type ProcessWagerResult } from "../../src/application/wagering/ProcessWagerTransaction";
import { ResumePendingTransactions } from "../../src/application/wagering/ResumePendingTransactions";
import type { WagerCommand } from "../../src/application/wagering/WagerCommand";
import { CreateWallet } from "../../src/application/wallets/CreateWallet";
import type { RetryPolicy } from "../../src/domain/wagering/WagerSettlement";
import type { WagerType } from "../../src/domain/wagering/WagerTransaction";

export const POLITICA_RAPIDA: RetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 };

// Telemetria que só conta, para os testes conferirem duplicatas e tentativas
export function telemetriaContadora(): Telemetry & { readonly contagem: Record<string, number> } {
    const contagem: Record<string, number> = {};
    const somar = (nome: string) => () => {
        contagem[nome] = (contagem[nome] ?? 0) + 1;
    };
    return {
        ...telemetriaVazia,
        duplicateRequest: somar("duplicateRequest"),
        duplicateMessage: somar("duplicateMessage"),
        retry: somar("retry"),
        lockConflict: somar("lockConflict"),
        contagem,
    };
}

export function casosDeUso(uow: UnitOfWork, telemetry: Telemetry = telemetriaVazia, politica = POLITICA_RAPIDA) {
    const relogio = () => new Date();
    return {
        criarCarteira: new CreateWallet(uow, relogio),
        processar: new ProcessWagerTransaction(uow, politica, telemetry, relogio),
        retomarPendentes: new ResumePendingTransactions(uow, politica, telemetry, relogio),
    };
}

let contador = 0;
export function idExterno(prefixo = "ext"): string {
    contador += 1;
    return prefixo + "-" + Date.now().toString(36) + "-" + contador;
}

export function comando(
    walletId: string,
    tipo: WagerType,
    valor: string,
    extra: Partial<WagerCommand> = {}
): WagerCommand {
    return {
        providerId: "prov-1",
        externalTransactionId: idExterno(tipo.toLowerCase()),
        type: tipo,
        playerId: "player-1",
        walletId,
        currency: "BRL",
        amount: valor,
        roundId: "round-1",
        referenceExternalTransactionId: null,
        gameId: null,
        ...extra,
    };
}

export function transacaoDe(r: ProcessWagerResult) {
    if (r.kind !== "completed") throw new Error("Esperava resultado completo, veio " + r.kind);
    return r.transaction;
}

export async function saldoNoBanco(sql: SQL, walletId: string): Promise<string> {
    const [linha] = await sql.unsafe("select balance::text as b from wallets where id = $1", [walletId]);
    return String((linha as { b: string }).b);
}
