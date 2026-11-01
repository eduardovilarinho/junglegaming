import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import type { Configuracao } from "../../config";
import { GameSchema } from "./GameRegistro";

// Configuração do MikroORM, usada pela API (via Nest) e pelo script de migrações.
export function criarConfigMikroOrm(config: Configuracao): Options {
    return defineConfig({
        clientUrl: config.banco.url,
        entities: [GameSchema],
        debug: config.banco.debug,
        pool: { min: 0, max: config.banco.maximoDeConexoes },
        extensions: [Migrator],
        migrations: {
            tableName: "mikro_orm_migrations",
            path: "src/infrastructure/persistencia/mikro-orm/migracoes",
            transactional: true,
            allOrNothing: true,
        },
    });
}
