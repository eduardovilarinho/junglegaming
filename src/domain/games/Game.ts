import { RegraDeDominioViolada } from "../identidade/Erros";
import type { ProvedorId } from "../identidade/Provedor";

export const TAMANHO_MAXIMO_DO_NOME = 200;

export interface DadosDoGame {
    readonly id: string;
    readonly nome: string;
    readonly provedorId: ProvedorId;
}

export class Game {
    readonly id: string;
    readonly nome: string;
    readonly provedorId: ProvedorId;

    constructor({ id, nome, provedorId }: DadosDoGame) {
        if (id.trim().length === 0) throw new RegraDeDominioViolada("Game precisa de um id");
        this.id = id;
        this.nome = Game.validarNome(nome);
        this.provedorId = provedorId;
    }

    private static validarNome(nome: string): string {
        const limpo = nome.trim();
        if (limpo.length === 0) {
            throw new RegraDeDominioViolada("Game precisa de um nome");
        }
        if (limpo.length > TAMANHO_MAXIMO_DO_NOME) {
            throw new RegraDeDominioViolada(
                "Nome do game deve ter no máximo " + TAMANHO_MAXIMO_DO_NOME + " caracteres"
            );
        }
        return limpo;
    }
}