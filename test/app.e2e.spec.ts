// Teste de ponta a ponta sem passar pelo Zitadel
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { provedorId } from "../src/domain/identidade/Provedor";
import { Game } from "../src/domain/games/Game";
import { RepositorioDeGamesEmMemoria } from "../src/infrastructure/persistencia/RepositorioDeGamesEmMemoria";
import { ZitadelValidadorDeToken } from "../src/infrastructure/zitadel/ZitadelValidadorDeToken";
import { carregarConfiguracao } from "../src/infrastructure/config";
import { CONFIGURACAO, REPOSITORIO_DE_GAMES, VALIDADOR_DE_TOKEN, VERIFICADORES_DE_SAUDE } from "../src/interfaces/http/tokens";
import { type ChavesDeTeste, criarChavesDeTeste, ISSUER, GAME } from "./zitadel-de-teste";

let app: INestApplication;
let chaves: ChavesDeTeste;

// Dependência falsa para o /health/ready: o teste liga e desliga
const verificadorFalso = {
    nome: "falso",
    disponivel: true,
    async verificar(): Promise<void> {
        if (!this.disponivel) throw new Error("fora do ar");
    },
};

// Sem workers (fila, outbox, pendências) e com autenticação ligada, independente do .env
const configuracaoDeTeste = (() => {
    const base = carregarConfiguracao();
    return { ...base, autenticacao: { modo: "zitadel" as const }, workers: { ...base.workers, habilitados: false } };
})();

beforeAll(async () => {
    chaves = await criarChavesDeTeste();

    const modulo = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CONFIGURACAO)
        .useValue(configuracaoDeTeste)
        .overrideProvider(VERIFICADORES_DE_SAUDE)
        .useValue([verificadorFalso])
        .overrideProvider(VALIDADOR_DE_TOKEN)
        .useValue(new ZitadelValidadorDeToken({ issuer: ISSUER, audience: GAME, jwks: chaves.jwks }))
        .overrideProvider(REPOSITORIO_DE_GAMES)
        .useValue(
            new RepositorioDeGamesEmMemoria([
                new Game({
                    id: "game-1", nome: "Game 1", provedorId: provedorId("provedor-a")
                }),
                new Game({
                    id: "game-3", nome: "Game 3", provedorId: provedorId("provedor-b")
                })
          ])
        )
        .compile();

    app = modulo.createNestApplication();
    await app.init();
});

afterAll(async () => {
    await app.close();
});

const servidor = (): Server => app.getHttpServer() as Server;

describe("API (e2e)", () => {
    it("/health/live responde sem token", async () => {
        await request(servidor()).get("/health/live").expect(200);
    });

    it("/health/ready responde 200 com as dependências no ar e 503 sem elas", async () => {
        verificadorFalso.disponivel = true;
        const pronto = await request(servidor()).get("/health/ready").expect(200);
        expect(pronto.body).toEqual({ status: "ok", checks: { falso: "up" } });

        verificadorFalso.disponivel = false;
        const fora = await request(servidor()).get("/health/ready").expect(503);
        expect(fora.body).toEqual({ status: "unavailable", checks: { falso: "down" } });

        verificadorFalso.disponivel = true;
    });

    it("/metrics responde sem token no formato do Prometheus", async () => {
        const r = await request(servidor()).get("/metrics").expect(200);
        expect(String(r.text)).toMatch(/wager_transactions_total/);
    });

    it("rotas financeiras exigem token quando a autenticação está ligada", async () => {
        await request(servidor()).get("/wallets/00000000-0000-0000-0000-000000000000").expect(401);
        await request(servidor()).post("/wagering/transactions").send({}).expect(401);
    });

    it("todo erro sai no mesmo formato { statusCode, error, message }, inclusive os do framework", async () => {
        const rota = await request(servidor()).get("/rota-que-nao-existe").expect(404);
        expect(rota.body).toMatchObject({ statusCode: 404, error: "NOT_FOUND" });
        const token = await chaves.assinar({ provedorId: "provedor-a", roles: {} });
        const malformado = await request(servidor())
            .post("/wallets")
            .set("Authorization", "Bearer " + token)
            .set("Content-Type", "application/json")
            .send('{"playerId": ')
            .expect(400);
        expect(malformado.body).toMatchObject({ statusCode: 400, error: "INVALID_PAYLOAD" });
    });

    it("401 sem token, com token inválido ou sem provedor", async () => {
        await request(servidor()).get("/me").expect(401);
        await request(servidor()).get("/me").set("Authorization", "Bearer abc").expect(401);
        const semProvedor = await chaves.assinar({ semProvedor: true });
        await request(servidor()).get("/me").set("Authorization", "Bearer " + semProvedor).expect(401);
    });

    it("/me traduz as claims do Zitadel para o perfil do domínio", async () => {
        const token = await chaves.assinar({
            provedorId: "provedor-a", roles: {
                admin: {
                    "provedor-a": "a"
                }
            }
        });
    const resposta = await request(servidor())
        .get("/me")
        .set("Authorization", "Bearer " + token)
        .expect(200);
        expect(resposta.body).toMatchObject({
            provedor: "provedor-a", roles: ["admin"], admin: true
        });
    });

    it("isolamento entre tenants nos games", async () => {
        const tokenB = await chaves.assinar({
            provedorId: "provedor-b", roles: {
                leitor: {
                    "provedor-b": "b"
                }
            }
        });
    const resposta = await request(servidor())
        .get("/games")
        .set("Authorization", "Bearer " + tokenB)
        .expect(200);
        expect(resposta.body).toEqual([{
            id: "game-3", nome: "Game 3" 
        }]);

    await request(servidor())
        .get("/provedores/provedor-a/games")
        .set("Authorization", "Bearer " + tokenB)
        .expect(403);
    });

    it("/admin exige admin no próprio provedor", async () => {
        const adminDaA = await chaves.assinar({
            provedorId: "provedor-a", roles: {
                admin: {
                    "provedor-a": "a"
                }
            }
        });
        const adminDeOutra = await chaves.assinar({
            provedorId: "provedor-b", roles: {
                admin: {
                    "provedor-a": "a"
                }
            }
        });
        await request(servidor()).get("/admin").set("Authorization", "Bearer " + adminDaA).expect(200);
        await request(servidor()).get("/admin").set("Authorization", "Bearer " + adminDeOutra).expect(403);
    });
});
