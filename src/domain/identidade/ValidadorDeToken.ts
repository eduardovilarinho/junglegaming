import type { Usuario } from "./Usuario";

export interface ValidadorDeToken {
    validar(token: string): Promise<Usuario>;
}
