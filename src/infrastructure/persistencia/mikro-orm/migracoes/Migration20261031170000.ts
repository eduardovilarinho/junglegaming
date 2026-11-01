import { Migration } from "@mikro-orm/migrations";

export class Migration20261031170000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            create table "games" (
                "id" uuid not null,
                "nome" varchar(200) not null,
                "provedor_id" varchar(64) not null,
                "criado_em" timestamptz not null default now(),
                constraint "games_pkey" primary key ("id")
            );
        `);
        this.addSql(`create index "games_provedor_id_index" on "games" ("provedor_id");`);
    }

    override async down(): Promise<void> {
        this.addSql(`drop table if exists "games" cascade;`);
    }
}