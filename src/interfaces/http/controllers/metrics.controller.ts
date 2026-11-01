import { Controller, Get, Header, Inject } from "@nestjs/common";
import { Metricas } from "../../../infrastructure/observabilidade/Metricas";
import { Publico } from "../autenticacao/decorators";
import { METRICAS } from "../tokens";

// Métricas no formato do Prometheus. Pública, como as rotas de health:
// em produção, ficaria acessível só pela rede interna.
@Publico()
@Controller("metrics")
export class MetricsController {
    constructor(@Inject(METRICAS) private readonly metricas: Metricas) {}

    @Get()
    @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    exportar(): string {
        return this.metricas.render();
    }
}
