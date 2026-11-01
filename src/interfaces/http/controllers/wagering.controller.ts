import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { ProviderMismatchError } from "../../../application/errors";
import { GetWagerTransaction } from "../../../application/wagering/GetWagerTransaction";
import { ProcessWagerTransaction } from "../../../application/wagering/ProcessWagerTransaction";
import { transactionView, type TransactionView } from "../../../application/views";
import { Provedor } from "../../../domain/identidade/Provedor";
import type { Usuario } from "../../../domain/identidade/Usuario";
import type { TransactionStatus } from "../../../domain/wagering/WagerTransaction";
import { enriquecerContexto } from "../../../infrastructure/observabilidade/contexto";
import { lerChaveDeIdempotencia, lerPedidoDeAposta } from "../../contratos/pedidos";
import { UsuarioOpcional } from "../autenticacao/decorators";

export interface RespostaDeTransacao extends TransactionView {
    /** true quando a resposta veio da idempotência (pedido repetido): mesmo status e mesmo saldo da primeira */
    readonly idempotentReplay: boolean;
}

// Status HTTP por resultado da transação:
//   201 Created              processada agora
//   202 Accepted             aceita, aguardando a transação referenciada (PENDING_REFERENCE)
//   422 Unprocessable Entity rejeição de negócio (o corpo traz failureCode)
// Um pedido repetido devolve o mesmo status da primeira resposta, com o cabeçalho
// Idempotent-Replayed: true e "idempotentReplay": true no corpo.
function statusPara(estado: TransactionStatus): HttpStatus {
    switch (estado) {
        case "PROCESSED":
            return HttpStatus.CREATED;
        case "PENDING":
        case "PENDING_REFERENCE":
            return HttpStatus.ACCEPTED;
        case "REJECTED":
        case "FAILED":
            return HttpStatus.UNPROCESSABLE_ENTITY;
    }
}

function exigirMesmoProvider(usuario: Usuario | null, providerId: string): void {
    // Com autenticação ligada, um provider só envia e consulta as próprias transações
    if (usuario !== null && !usuario.podeAcessar(new Provedor(providerId))) {
        throw new ProviderMismatchError("O token pertence ao provider " + usuario.provedor.id + ", não a " + providerId);
    }
}

@Controller()
export class WageringController {
    constructor(
        @Inject(ProcessWagerTransaction) private readonly processar: ProcessWagerTransaction,
        @Inject(GetWagerTransaction) private readonly consultar: GetWagerTransaction
    ) {}

    @Post("wagering/transactions")
    async criar(
        @Headers("idempotency-key") cabecalho: string | undefined,
        @Body() corpo: unknown,
        @UsuarioOpcional() usuario: Usuario | null,
        @Res({ passthrough: true }) resposta: Response
    ): Promise<RespostaDeTransacao> {
        const chave = lerChaveDeIdempotencia(cabecalho);
        const pedido = lerPedidoDeAposta(corpo);
        exigirMesmoProvider(usuario, pedido.providerId);
        enriquecerContexto({ providerId: pedido.providerId, walletId: pedido.walletId });

        const resultado = await this.processar.execute({ command: pedido, idempotencyKey: chave, origin: "http" });
        if (resultado.kind !== "completed") throw new Error("Resultado inesperado para pedido HTTP: " + resultado.kind);

        const t = resultado.transaction;
        enriquecerContexto({ transactionId: t.id });
        resposta.status(statusPara(t.status));
        if (resultado.replayed) resposta.setHeader("Idempotent-Replayed", "true");
        return { ...transactionView(t), idempotentReplay: resultado.replayed };
    }

    @Get("wagering/transactions/:transactionId")
    async porId(
        @Param("transactionId") id: string,
        @UsuarioOpcional() usuario: Usuario | null
    ): Promise<TransactionView> {
        const t = await this.consultar.byId(id);
        exigirMesmoProvider(usuario, t.providerId);
        return t;
    }

    @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
    async porIdExterno(
        @Param("providerId") providerId: string,
        @Param("externalTransactionId") externo: string,
        @UsuarioOpcional() usuario: Usuario | null
    ): Promise<TransactionView> {
        exigirMesmoProvider(usuario, providerId);
        return this.consultar.byExternalId(providerId, externo);
    }
}
