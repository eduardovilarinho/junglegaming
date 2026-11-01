import type { EntityManager } from "@mikro-orm/postgresql";
import { comTempoLimite, type Verificador } from "./Verificador";

export class VerificadorPostgres implements Verificador {
    readonly nome = "postgres";

    constructor(private readonly em: EntityManager) {}

    verificar(): Promise<void> {
        return comTempoLimite(this.em.getConnection().execute("select 1"), 2000);
    }
}
