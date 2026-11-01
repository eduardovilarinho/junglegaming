import { Controller, Get, Inject } from "@nestjs/common";
import { ObterPerfil, type PerfilDTO } from "../../../application/ObterPerfil";
import { Role } from "../../../domain/identidade/Role";
import { Usuario } from "../../../domain/identidade/Usuario";
import { RolesExigidas, UsuarioAtual } from "../autenticacao/decorators";

@Controller()
export class PerfilController {
    constructor(@Inject(ObterPerfil) private readonly obterPerfil: ObterPerfil) {}

    @Get("me")
    me(@UsuarioAtual() usuario: Usuario): PerfilDTO {
        return this.obterPerfil.executar(usuario);
    }

    @RolesExigidas(Role.ADMIN)
    @Get("admin")
    admin(@UsuarioAtual() usuario: Usuario): { readonly msg: string } {
        return { msg: "Área de administradores da organização " + usuario.provedor.id };
    }
}
