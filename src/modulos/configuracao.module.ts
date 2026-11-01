import { Global, Module } from "@nestjs/common";
import { carregarConfiguracao } from "../infrastructure/config";
import { CONFIGURACAO } from "../interfaces/http/tokens";

@Global()
@Module({
  providers: [{ provide: CONFIGURACAO, useFactory: carregarConfiguracao }],
  exports: [CONFIGURACAO],
})
export class ConfiguracaoModule {}
