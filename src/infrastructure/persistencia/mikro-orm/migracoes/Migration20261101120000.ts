import { Migration } from "@mikro-orm/migrations";
import { SCHEMA_FINANCEIRO_DOWN, SCHEMA_FINANCEIRO_UP } from "../../sql/schema";

// Núcleo financeiro: carteiras, transações, reversões, ledger, idempotência, inbox, outbox
// e relatórios de reconciliação. O SQL fica em sql/schema.ts (compartilhado com os testes).
export class Migration20261101120000 extends Migration {
    override async up(): Promise<void> {
        for (const comando of SCHEMA_FINANCEIRO_UP) this.addSql(comando);
    }

    override async down(): Promise<void> {
        for (const comando of SCHEMA_FINANCEIRO_DOWN) this.addSql(comando);
    }
}
