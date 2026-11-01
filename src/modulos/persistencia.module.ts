import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { Configuracao } from "../infrastructure/config";
import { criarConfigMikroOrm } from "../infrastructure/persistencia/mikro-orm/mikro-orm.config";
import { CONFIGURACAO } from "../interfaces/http/tokens";
import { ConfiguracaoModule } from "./configuracao.module";

@Module({
    imports: [
        MikroOrmModule.forRootAsync({
            imports: [ConfiguracaoModule],
            inject: [CONFIGURACAO],
            useFactory: (config: Configuracao) => criarConfigMikroOrm(config),
            driver: PostgreSqlDriver,
        }),
    ],
})
export class PersistenciaModule { }