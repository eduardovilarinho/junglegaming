import { NaoAutenticadoError } from "../domain/identidade/Erros";
import type { Usuario } from "../domain/identidade/Usuario";
import type { ValidadorDeToken } from "../domain/identidade/ValidadorDeToken";

export class AutenticarUsuario {
    constructor(private readonly validadorDeToken: ValidadorDeToken) {}

    async executar(token: string | null | undefined): Promise<Usuario> {
        if (!token) throw new NaoAutenticadoError("Token ausente");
        return this.validadorDeToken.validar(token);
    }
}
