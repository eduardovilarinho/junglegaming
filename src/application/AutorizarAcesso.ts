import { AcessoNegadoError } from "../domain/identidade/Erros";
import type { Provedor } from "../domain/identidade/Provedor";
import { Role } from "../domain/identidade/Role";
import type { Usuario } from "../domain/identidade/Usuario";

export class AutorizarAcesso {
    executar(
        usuario: Usuario,
        roleExigida: Role | string,
        provedor: Provedor = usuario.provedor
        ): void {
            const role = Role.de(roleExigida);
            if (!usuario.possuiRole(role, provedor)) {
                throw new AcessoNegadoError(
                "Requer a role " + role.nome + " no provedor " + provedor.id
            );
        }
    }
}
