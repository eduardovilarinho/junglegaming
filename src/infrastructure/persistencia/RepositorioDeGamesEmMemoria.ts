import type { Provedor } from "../../domain/identidade/Provedor";
import type { Game } from "../../domain/games/Game";
import type { RepositorioDeGames } from "../../domain/games/RepositorioDeGames";

export class RepositorioDeGamesEmMemoria implements RepositorioDeGames {
    readonly #games: Game[];
    constructor(games: readonly Game[] = []) {
        this.#games = [...games];
    }
    async listarPorProvedor(provedor: Provedor): Promise<readonly Game[]> {
        return this.#games.filter((p) => p.provedorId === provedor.id);
    }
}