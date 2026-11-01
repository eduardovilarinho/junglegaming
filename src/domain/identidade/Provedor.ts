import { RegraDeDominioViolada } from "./Erros";

export type ProvedorId = string & { readonly __marca: "ProvedorId" };
export function provedorId(valor: string): ProvedorId {
    const id = valor.trim();
    if (id.length === 0) throw new RegraDeDominioViolada("Provedor precisa de um id");
    return id as ProvedorId;
}

export class Provedor {
    readonly id: ProvedorId;
    readonly dominio: string | null;

    constructor(id: ProvedorId | string, dominio: string | null = null) {
        this.id = provedorId(id);
        this.dominio = dominio;
        Object.freeze(this);
    }

    equals(outra: Provedor): boolean {
        return outra.id === this.id;
    }
}