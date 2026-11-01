import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { InvalidRequestError } from "../../../application/errors";
import type { WalletView } from "../../../application/views";
import { CreateWallet } from "../../../application/wallets/CreateWallet";
import { LIMITE_PADRAO, QueryWallets, type LedgerPage } from "../../../application/wallets/QueryWallets";
import { ReconcileWallet, type ReconciliationView } from "../../../application/wallets/ReconcileWallet";
import { enriquecerContexto } from "../../../infrastructure/observabilidade/contexto";
import { lerPedidoDeCarteira } from "../../contratos/pedidos";

function lerLimite(valor: string | undefined): number {
    if (valor === undefined || valor === "") return LIMITE_PADRAO;
    if (!/^\d{1,4}$/.test(valor)) throw new InvalidRequestError("limit deve ser um número inteiro");
    return Number(valor);
}

@Controller("wallets")
export class WalletsController {
    constructor(
        @Inject(CreateWallet) private readonly criarCarteira: CreateWallet,
        @Inject(QueryWallets) private readonly consultas: QueryWallets,
        @Inject(ReconcileWallet) private readonly reconciliar: ReconcileWallet
    ) {}

    /** 201 com a carteira; 409 se o jogador já tem carteira nesta moeda */
    @Post()
    async criar(@Body() corpo: unknown): Promise<WalletView> {
        const carteira = await this.criarCarteira.execute(lerPedidoDeCarteira(corpo));
        enriquecerContexto({ walletId: carteira.id });
        return carteira;
    }

    @Get(":walletId")
    obter(@Param("walletId") walletId: string): Promise<WalletView> {
        enriquecerContexto({ walletId });
        return this.consultas.getWallet(walletId);
    }

    /** Paginação por cursor opaco: ?limit=50&cursor=<nextCursor da página anterior> */
    @Get(":walletId/ledger")
    livroRazao(
        @Param("walletId") walletId: string,
        @Query("cursor") cursor: string | undefined,
        @Query("limit") limite: string | undefined
    ): Promise<LedgerPage> {
        enriquecerContexto({ walletId });
        return this.consultas.getLedger(walletId, cursor === undefined || cursor === "" ? null : cursor, lerLimite(limite));
    }

    /** Compara o saldo gravado com o ledger. Divergência é registrada, nunca corrigida. */
    @Post(":walletId/reconciliation")
    @HttpCode(HttpStatus.OK)
    reconciliacao(@Param("walletId") walletId: string): Promise<ReconciliationView> {
        enriquecerContexto({ walletId });
        return this.reconciliar.execute(walletId);
    }
}
