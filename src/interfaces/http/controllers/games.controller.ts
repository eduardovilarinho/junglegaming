import { Controller, Get, Inject, Param } from "@nestjs/common";
import { ListarGames, type GameDTO } from "../../../application/ListarGames";
import { Usuario } from "../../../domain/identidade/Usuario";
import { UsuarioAtual } from "../autenticacao/decorators";

@Controller()
export class GamesController {
    constructor(@Inject(ListarGames) private readonly listarGames: ListarGames) {}

    @Get("games")
    listar(@UsuarioAtual() usuario: Usuario): Promise<readonly GameDTO[]> {
        return this.listarGames.executar(usuario);
    }

    @Get("provedores/:provedorId/games")
    listarDaProvedor(
        @UsuarioAtual() usuario: Usuario,
        @Param("provedorId") provedorId: string
        ): Promise<readonly GameDTO[]> {
            return this.listarGames.executar(usuario, provedorId);
    }
}