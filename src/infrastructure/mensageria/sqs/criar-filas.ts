import { carregarConfiguracao } from "../../config";
import { criarClienteSqs } from "./cliente-sqs";
import { criarFilas } from "./filas";

// Script: bun run sqs:setup
const config = carregarConfiguracao();
const sqs = criarClienteSqs(config.sqs);
criarFilas(sqs, config.sqs)
    .then(() => {
        console.log("Filas prontas: " + [config.sqs.filaDeTransacoes, config.sqs.filaDeTransacoesDlq, config.sqs.filaDeEventos].join(", "));
    })
    .catch((erro: unknown) => {
        console.error("Falha ao criar as filas", erro);
        process.exitCode = 1;
    })
    .finally(() => sqs.destroy());
