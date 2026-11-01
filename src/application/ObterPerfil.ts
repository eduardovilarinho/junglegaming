import type { Usuario } from "../domain/identidade/Usuario";

export interface PerfilDTO {
    readonly id: string;
    readonly usuario: string;
    readonly email: string | null;
    readonly provedor: string;
    readonly roles: readonly string[];
    readonly admin: boolean;
}
export class ObterPerfil {
    executar(usuario: Usuario): PerfilDTO {
        return {
            id: usuario.id,
            usuario: usuario.username,
            email: usuario.email,
            provedor: usuario.provedor.id,
            roles: usuario.rolesEm().map((r) => r.nome),
            admin: usuario.ehAdminDe(),
        };
    }
}