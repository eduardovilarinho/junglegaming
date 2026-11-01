import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AutenticarUsuario } from "../application/AutenticarUsuario";
import { AutorizarAcesso } from "../application/AutorizarAcesso";
import { ObterPerfil } from "../application/ObterPerfil";
import type { ValidadorDeToken } from "../domain/identidade/ValidadorDeToken";
import type { Configuracao } from "../infrastructure/config";
import { ZitadelValidadorDeToken } from "../infrastructure/zitadel/ZitadelValidadorDeToken";
import { AutenticacaoGuard } from "../interfaces/http/autenticacao/autenticacao.guard";
import { AutorizacaoGuard } from "../interfaces/http/autenticacao/autorizacao.guard";
import { PerfilController } from "../interfaces/http/controllers/perfil.controller";
import { CONFIGURACAO, VALIDADOR_DE_TOKEN } from "../interfaces/http/tokens";

@Module({
    controllers: [PerfilController],
    providers: [
    {
        provide: VALIDADOR_DE_TOKEN,
        inject: [CONFIGURACAO],
        useFactory: (config: Configuracao): ValidadorDeToken =>
        new ZitadelValidadorDeToken(config.zitadel),
    },
    {
        provide: AutenticarUsuario,
        inject: [VALIDADOR_DE_TOKEN],
        useFactory: (validador: ValidadorDeToken): AutenticarUsuario =>
        new AutenticarUsuario(validador),
    },
    { provide: AutorizarAcesso, useFactory: (): AutorizarAcesso => new AutorizarAcesso() },
    { provide: ObterPerfil, useFactory: (): ObterPerfil => new ObterPerfil() },

    { provide: APP_GUARD, useClass: AutenticacaoGuard },
    { provide: APP_GUARD, useClass: AutorizacaoGuard },
    ],
    exports: [VALIDADOR_DE_TOKEN, AutenticarUsuario, AutorizarAcesso]
})
export class IdentidadeModule {}
