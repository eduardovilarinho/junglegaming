import { MikroORM } from "@mikro-orm/postgresql";
import { carregarConfiguracao } from "../../config";
import { criarConfigMikroOrm } from "./mikro-orm.config";

// Migrações rodando no Bun: bun migrar.ts up | down | pending | create
async function executar(comando: string | undefined): Promise<void> {
    const orm = await MikroORM.init(criarConfigMikroOrm(carregarConfiguracao()));
    try {
        switch (comando) {
            case "up": {
                const aplicadas = await orm.migrator.up();
                console.log(aplicadas.length === 0 ? "Nenhuma migração pendente." : "Aplicadas: " + aplicadas.map((m) => m.name).join(", "));
                break;
            }
            case "down": {
                const desfeitas = await orm.migrator.down();
                console.log(desfeitas.length === 0 ? "Nada para desfazer." : "Desfeitas: " + desfeitas.map((m) => m.name).join(", "));
                break;
            }
            case "pending": {
                const pendentes = await orm.migrator.getPending();
                console.log(pendentes.length === 0 ? "Nenhuma migração pendente." : "Pendentes: " + pendentes.map((m) => m.name).join(", "));
                break;
            }
            case "create": {
                const resultado = await orm.migrator.create();
                console.log(resultado.diff.up.length === 0 ? "Nenhuma mudança no schema." : "Criada: " + resultado.fileName);
                break;
            }
            default:
                throw new Error("Comando inválido. Use: up | down | pending | create");
        }
    } finally {
        await orm.close(true);
    }
}

executar(process.argv[2]).catch((erro: unknown) => {
    console.error(erro);
    process.exit(1);
});
