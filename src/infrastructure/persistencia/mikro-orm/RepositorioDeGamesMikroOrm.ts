import type { EntityManager } from "@mikro-orm/postgresql";
import { provedorId, type Provedor } from "../../../domain/identidade/Provedor";
import { Game } from "../../../domain/games/Game";
import type { RepositorioDeGames } from "../../../domain/games/RepositorioDeGames";
import { GameRegistro } from "./GameRegistro";

export class RepositorioDeGamesMikroOrm implements RepositorioDeGames {
    constructor(private readonly em: EntityManager) { }

    async listarPorProvedor(provedor: Provedor): Promise<readonly Game[]> {
        const registros = await this.em.find(
            GameRegistro,
            { provedorId: provedor.id },
            { orderBy: { criadoEm: "asc" } }
        );
        return registros.map(paraDominio);
    }
}

function paraDominio(registro: GameRegistro): Game {
    return new Game({
        id: registro.id,
        nome: registro.nome,
        provedorId: provedorId(registro.provedorId),
    });
}