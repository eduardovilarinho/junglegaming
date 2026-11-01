import type { Provedor } from "../identidade/Provedor";
import type { Game } from "./Game";

export interface RepositorioDeGames {
    listarPorProvedor(provedor: Provedor): Promise<readonly Game[]>;
}
