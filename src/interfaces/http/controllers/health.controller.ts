import { Controller, Get, HttpStatus, Inject, Logger, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Verificador } from "../../../infrastructure/saude/Verificador";
import { Publico } from "../autenticacao/decorators";
import { VERIFICADORES_DE_SAUDE } from "../tokens";

type EstadoDaDependencia = "up" | "down";

export interface RespostaDeSaude {
    readonly status: "ok" | "unavailable";
    readonly checks: Readonly<Record<string, EstadoDaDependencia>>;
}

// Sem autenticação, como o desafio pede.
// live = o processo está de pé; ready = consegue atender (PostgreSQL e SQS alcançáveis).
@Publico()
@Controller("health")
export class HealthController {
    readonly #logger = new Logger(HealthController.name);

    constructor(@Inject(VERIFICADORES_DE_SAUDE) private readonly verificadores: readonly Verificador[]) {}

    @Get("live")
    live(): { readonly status: "ok" } {
        return { status: "ok" };
    }

    @Get("ready")
    async ready(@Res({ passthrough: true }) http: Response): Promise<RespostaDeSaude> {
        const resultados = await Promise.all(
            this.verificadores.map(async (verificador) => {
                try {
                    await verificador.verificar();
                    return [verificador.nome, "up"] as const;
                } catch (erro: unknown) {
                    // O motivo vai para o log, não para a resposta: a rota é pública
                    const motivo = erro instanceof Error ? erro.message : String(erro);
                    this.#logger.warn(verificador.nome + " indisponível: " + motivo);
                    return [verificador.nome, "down"] as const;
                }
            })
        );

        const resposta: RespostaDeSaude = {
            status: resultados.every(([, estado]) => estado === "up") ? "ok" : "unavailable",
            checks: Object.fromEntries(resultados),
        };
        // 503 com o mesmo corpo: o orquestrador vê o status e quem investiga vê qual dependência caiu
        if (resposta.status === "unavailable") http.status(HttpStatus.SERVICE_UNAVAILABLE);
        return resposta;
    }
}
