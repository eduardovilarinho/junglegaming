import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ErroDeDominioFilter } from "./interfaces/http/filtros/erro-de-dominio.filter";
import { ConfiguracaoModule } from "./modulos/configuracao.module";
import { FinanceiroModule } from "./modulos/financeiro.module";
import { GamesModule } from "./modulos/games.module";
import { IdentidadeModule } from "./modulos/identidade.module";
import { MensageriaModule } from "./modulos/mensageria.module";
import { ObservabilidadeModule } from "./modulos/observabilidade.module";
import { PersistenciaModule } from "./modulos/persistencia.module";
import { SaudeModule } from "./modulos/saude.module";
import { WorkersModule } from "./modulos/workers.module";

@Module({
    imports: [
        ConfiguracaoModule,
        ObservabilidadeModule,
        PersistenciaModule,
        MensageriaModule,
        IdentidadeModule,
        GamesModule,
        FinanceiroModule,
        WorkersModule,
        SaudeModule,
    ],
    providers: [{ provide: APP_FILTER, useClass: ErroDeDominioFilter }],
})
export class AppModule {}
