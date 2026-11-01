import { isUuid } from "../../domain/shared/identifiers";
import { InvalidRequestError, NotFoundError } from "../errors";
import type { UnitOfWork } from "../ports";
import { ledgerEntryView, walletView, type LedgerEntryView, type WalletView } from "../views";

export interface LedgerPage {
    readonly items: readonly LedgerEntryView[];
    /** Cursor opaco para a próxima página; null quando não há mais */
    readonly nextCursor: string | null;
}

export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 200;

// Cursor opaco: base64url de {"v": "<versão>"}. O cliente não deve montar nem interpretar o cursor.
// Paginar pela versão da carteira é estável: lançamentos novos entram sempre no fim,
// então páginas já lidas nunca mudam nem pulam itens.
export function codificarCursor(versao: bigint): string {
    return Buffer.from(JSON.stringify({ v: versao.toString() })).toString("base64url");
}

export function decodificarCursor(cursor: string): bigint {
    try {
        const dado: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (typeof dado === "object" && dado !== null && "v" in dado && typeof dado.v === "string" && /^\d{1,19}$/.test(dado.v)) {
            return BigInt(dado.v);
        }
    } catch {
        // cai no erro abaixo
    }
    throw new InvalidRequestError("Cursor inválido");
}

export class QueryWallets {
    constructor(private readonly uow: UnitOfWork) {}

    async getWallet(id: string): Promise<WalletView> {
        if (!isUuid(id)) throw new NotFoundError("Carteira " + id + " não encontrada");
        const w = await this.uow.run((ctx) => ctx.wallets.findById(id));
        if (w === null) throw new NotFoundError("Carteira " + id + " não encontrada");
        return walletView(w);
    }

    async getLedger(walletId: string, cursor: string | null, limite: number): Promise<LedgerPage> {
        if (!isUuid(walletId)) throw new NotFoundError("Carteira " + walletId + " não encontrada");
        if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) {
            throw new InvalidRequestError("limit deve ser um inteiro entre 1 e " + LIMITE_MAXIMO);
        }
        const depoisDe = cursor === null ? null : decodificarCursor(cursor);

        return this.uow.run(async (ctx) => {
            const w = await ctx.wallets.findById(walletId);
            if (w === null) throw new NotFoundError("Carteira " + walletId + " não encontrada");
            // Busca um item a mais só para saber se existe próxima página
            const linhas = await ctx.ledger.page(walletId, depoisDe, limite + 1);
            const pagina = linhas.slice(0, limite);
            const ultimo = pagina.at(-1);
            return {
                items: pagina.map(ledgerEntryView),
                nextCursor: linhas.length > limite && ultimo !== undefined ? codificarCursor(ultimo.walletVersion) : null,
            };
        });
    }
}
