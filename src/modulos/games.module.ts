import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { ListarGames } from "../application/ListarGames";
import type { RepositorioDeGames } from "../domain/games/RepositorioDeGames";
import { RepositorioDeGamesMikroOrm } from "../infrastructure/persistencia/mikro-orm/RepositorioDeGamesMikroOrm";
import { GamesController } from "../interfaces/http/controllers/games.controller";
import { REPOSITORIO_DE_GAMES } from "../interfaces/http/tokens";
import { IdentidadeModule } from "./identidade.module";

@Module({
    imports: [IdentidadeModule],
    controllers: [GamesController],
    providers: [
        {
            provide: REPOSITORIO_DE_GAMES,
            inject: [EntityManager],
            useFactory: (em: EntityManager): RepositorioDeGames => new RepositorioDeGamesMikroOrm(em),
        },
        {
            provide: ListarGames,
            inject: [REPOSITORIO_DE_GAMES],
            useFactory: (repositorio: RepositorioDeGames): ListarGames =>
                new ListarGames(repositorio),
        }
    ],
})
export class GamesModule { }