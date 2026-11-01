import { RegraDeDominioViolada } from "./Erros";

export class Role {
    static readonly ADMIN = new Role("admin");
    static readonly LEITOR = new Role("leitor");

    readonly nome: string;

    constructor(nome: string) {
        const normalizado = nome.trim().toLowerCase();
        if (normalizado.length === 0) {
            throw new RegraDeDominioViolada("Role precisa de um nome");
        }
        this.nome = normalizado;
        Object.freeze(this);
    }

    equals(outra: Role): boolean {
        return outra.nome === this.nome;
    }

    static de(valor: Role | string): Role {
        return valor instanceof Role ? valor : new Role(valor);
    }
}