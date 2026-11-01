import { RegraDeDominioViolada } from "./Erros";
import { Provedor, ProvedorId, provedorId } from "./Provedor";
import { Role } from "./Role";

export interface DadosDoUsuario {
    readonly id: string;
    readonly username: string;
    readonly email?: string | null;
    readonly provedor: Provedor;
    readonly rolesPorProvedor?: Readonly<Record<string, readonly (Role | string)[]>>;
}

export class Usuario {
    readonly id: string;
    readonly username: string;
    readonly email: string | null;
    readonly provedor: Provedor;
    readonly #rolesPorProvedor: ReadonlyMap<ProvedorId, readonly Role[]>;

    constructor(dados: DadosDoUsuario) {
        if (dados.id.trim().length === 0) {
            throw new RegraDeDominioViolada("Usuario precisa de um id");
        }
        if (dados.username.trim().length === 0) {
            throw new RegraDeDominioViolada("Usuario precisa de um username");
        }

        this.id = dados.id;
        this.username = dados.username;
        this.email = dados.email ?? null;
        this.provedor = dados.provedor;
        this.#rolesPorProvedor = new Map(
            Object.entries(dados.rolesPorProvedor ?? {}).map(
                ([id, roles]) => [provedorId(id), Object.freeze(roles.map(Role.de))] as const
            )
        );
    }

    rolesEm(provedor: Provedor = this.provedor): readonly Role[] {
        return this.#rolesPorProvedor.get(provedor.id) ?? [];
    }

    possuiRole(role: Role, provedor: Provedor = this.provedor): boolean {
        return this.rolesEm(provedor).some((r) => r.equals(role));
    }

    ehAdminDe(provedor: Provedor = this.provedor): boolean {
        return this.possuiRole(Role.ADMIN, provedor);
    }

    podeAcessar(provedor: Provedor): boolean {
        return this.provedor.equals(provedor) || this.rolesEm(provedor).length > 0;
    }
}