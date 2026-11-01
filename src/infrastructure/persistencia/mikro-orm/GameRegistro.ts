import { EntitySchema } from "@mikro-orm/postgresql";

export class GameRegistro {
    id!: string;
    nome!: string;
    provedorId!: string;
    criadoEm!: Date;
}

export const GameSchema = new EntitySchema<GameRegistro>({
    class: GameRegistro,
    tableName: "games",
    properties: {
        id: { type: "uuid", primary: true },
        nome: { type: "string", length: 200 },
        provedorId: { type: "string", length: 64, index: true },
        criadoEm: { type: "datetime", defaultRaw: "now()" },
    },
});