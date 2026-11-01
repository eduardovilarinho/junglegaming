import { AcessoNegadoError } from "../domain/identidade/Erros";
import { Provedor } from "../domain/identidade/Provedor";
import type { Usuario } from "../domain/identidade/Usuario";
import type { RepositorioDeGames } from "../domain/games/RepositorioDeGames";

export interface GameDTO {
    readonly id: string;
    readonly nome: string;
    }

export class ListarGames {
    constructor(private readonly repositorio: RepositorioDeGames) {}

    async executar(usuario: Usuario, provedorId?: string): Promise<readonly GameDTO[]> {
        const provedor =
            provedorId === undefined ? usuario.provedor : new Provedor(provedorId);

        if (!usuario.podeAcessar(provedor)) {
            throw new AcessoNegadoError("Sem acesso ao provedor " + provedor.id);
        }

        const games = await this.repositorio.listarPorProvedor(provedor);
        return games.map((p) => ({ id: p.id, nome: p.nome }));
    }
}