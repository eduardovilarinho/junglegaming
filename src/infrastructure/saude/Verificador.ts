// Uma dependência externa que a rota /health/ready precisa alcançar
export interface Verificador {
    readonly nome: string;
    verificar(): Promise<void>;
}

// Falha se a verificação demorar mais que `ms`: um banco travado não pode travar o health check
export async function comTempoLimite(promessa: Promise<unknown>, ms: number): Promise<void> {
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const limite = new Promise<never>((_, rejeitar) => {
        temporizador = setTimeout(() => rejeitar(new Error("tempo esgotado após " + ms + " ms")), ms);
    });
    try {
        await Promise.race([promessa, limite]);
    } finally {
        clearTimeout(temporizador);
    }
}
