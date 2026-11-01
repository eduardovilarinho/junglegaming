import { RegraDeDominioViolada } from "../identidade/Erros";

const IDENTIFICADOR = /^[A-Za-z0-9._:@-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Identificadores externos (provider, player, round, transação externa):
// texto curto, sem espaços, para não virar vetor de lixo ou injeção em logs.
export function requireIdentifier(rotulo: string, valor: string, tamanhoMaximo: number): string {
    if (valor.length === 0 || valor.length > tamanhoMaximo || !IDENTIFICADOR.test(valor)) {
        throw new RegraDeDominioViolada(
            rotulo + " inválido: use até " + tamanhoMaximo + " caracteres entre letras, números e . _ : @ -"
        );
    }
    return valor;
}

export function requireUuid(rotulo: string, valor: string): string {
    if (!UUID.test(valor)) throw new RegraDeDominioViolada(rotulo + " deve ser um UUID em minúsculas");
    return valor;
}

export function isUuid(valor: string): boolean {
    return UUID.test(valor);
}
