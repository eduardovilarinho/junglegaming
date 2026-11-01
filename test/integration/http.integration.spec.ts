import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { carregarConfiguracao, type Configuracao } from "../../src/infrastructure/config";
import { ZitadelValidadorDeToken } from "../../src/infrastructure/zitadel/ZitadelValidadorDeToken";
import { configurarAplicacao } from "../../src/interfaces/http/configurar-aplicacao";
import { CONFIGURACAO, UNIDADE_DE_TRABALHO, VALIDADOR_DE_TOKEN } from "../../src/interfaces/http/tokens";
import { conferirInvariantes, DRIVER, INTEGRACAO_HABILITADA, prepararBanco, URL_DO_BANCO_DE_TESTE, type BancoDeTeste } from "../support/database";
import { idExterno } from "../support/cenarios";
import { criarChavesDeTeste, GAME, ISSUER, type ChavesDeTeste } from "../zitadel-de-teste";

// Contrato HTTP de ponta a ponta, com o PostgreSQL de verdade.
// Rodar com: INTEGRATION=1 bun test test/integration
describe.skipIf(!INTEGRACAO_HABILITADA)("API HTTP com PostgreSQL (" + DRIVER + ")", () => {
    let banco: BancoDeTeste;
    let app: INestApplication;
    let chaves: ChavesDeTeste;

    async function subir(ajuste: (c: Configuracao) => Configuracao): Promise<INestApplication> {
        const base = carregarConfiguracao();
        // A aplicação inteira aponta para o banco de teste, nunca para o banco de desenvolvimento
        const config = ajuste({
            ...base,
            banco: { ...base.banco, url: URL_DO_BANCO_DE_TESTE },
            workers: { ...base.workers, habilitados: false },
        });
        const modulo = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(CONFIGURACAO)
            .useValue(config)
            .overrideProvider(UNIDADE_DE_TRABALHO)
            .useValue(banco.uow)
            .overrideProvider(VALIDADOR_DE_TOKEN)
            .useValue(new ZitadelValidadorDeToken({ issuer: ISSUER, audience: GAME, jwks: chaves.jwks }))
            .compile();
        const instancia = modulo.createNestApplication();
        configurarAplicacao(instancia);
        await instancia.init();
        return instancia;
    }

    beforeAll(async () => {
        banco = await prepararBanco();
        chaves = await criarChavesDeTeste();
        app = await subir((c) => ({ ...c, autenticacao: { modo: "desativada" } }));
    });

    afterEach(async () => {
        await conferirInvariantes(banco.sql);
    });

    afterAll(async () => {
        await app.close();
        await banco.fechar();
    });

    const http = () => request(app.getHttpServer() as Server);

    async function criarCarteira(saldo: string): Promise<{ id: string; playerId: string }> {
        const playerId = idExterno("player");
        const r = await http().post("/wallets").send({ playerId, initialBalance: { amount: saldo, currency: "BRL" } }).expect(201);
        return { id: String(r.body.id), playerId };
    }

    function aposta(carteira: { id: string; playerId: string }, tipo: string, valor: string, extra: Record<string, unknown> = {}) {
        return {
            providerId: "prov-1",
            externalTransactionId: idExterno(tipo.toLowerCase()),
            kind: tipo,
            playerId: carteira.playerId,
            walletId: carteira.id,
            money: { amount: valor, currency: "BRL" },
            roundId: "round-1",
            ...extra,
        };
    }

    describe("carteiras", () => {
        it("cria (201), consulta (200) e recusa duplicada (409)", async () => {
            const c = await criarCarteira("25.50");
            const r = await http().get("/wallets/" + c.id).expect(200);
            expect(r.body).toEqual({
                id: c.id, playerId: c.playerId, balance: { amount: "25.50", currency: "BRL" }, version: 1, createdAt: expect.any(String),
            });
            const semSaldo = await http().post("/wallets").send({ playerId: idExterno("player"), currency: "BRL" }).expect(201);
            expect(semSaldo.body).toMatchObject({ balance: { amount: "0.00", currency: "BRL" }, version: 1 });
            const dup = await http().post("/wallets").send({ playerId: c.playerId, currency: "BRL" }).expect(409);
            expect(dup.body.error).toBe("WALLET_ALREADY_EXISTS");
        });

        it("payload inválido é 400: número em vez de string, moeda errada, campo faltando", async () => {
            await http().post("/wallets").send({ playerId: "p", initialBalance: { amount: 10.5, currency: "BRL" } }).expect(400);
            await http().post("/wallets").send({ playerId: "p", currency: "real" }).expect(400);
            const r = await http().post("/wallets").send({ currency: "BRL" }).expect(400);
            expect(r.body.error).toBe("INVALID_PAYLOAD");
        });

        it("carteira inexistente é 404", async () => {
            await http().get("/wallets/" + crypto.randomUUID()).expect(404);
            await http().get("/wallets/nao-e-uuid").expect(404);
        });
    });

    describe("transações", () => {
        it("exige Idempotency-Key", async () => {
            const c = await criarCarteira("10.00");
            const r = await http().post("/wagering/transactions").send(aposta(c, "BET", "1.00")).expect(400);
            expect(r.body.error).toBe("INVALID_PAYLOAD");
        });

        it("processada = 201; repetida = mesma resposta com Idempotent-Replayed; mesma chave e outro conteúdo = 409", async () => {
            const c = await criarCarteira("10.00");
            const corpo = aposta(c, "BET", "4.00");
            const primeira = await http().post("/wagering/transactions").set("Idempotency-Key", "k-" + corpo.externalTransactionId).send(corpo).expect(201);
            expect(primeira.body).toMatchObject({
                transactionId: expect.any(String),
                status: "PROCESSED",
                money: { amount: "4.00", currency: "BRL" },
                balance: { amount: "6.00", currency: "BRL" },
                idempotentReplay: false,
            });

            // Outra aposta muda o saldo; a repetição continua devolvendo o saldo observado na primeira vez
            const outra = aposta(c, "BET", "1.00");
            await http().post("/wagering/transactions").set("Idempotency-Key", outra.externalTransactionId).send(outra).expect(201);

            const repetida = await http().post("/wagering/transactions").set("Idempotency-Key", "k-" + corpo.externalTransactionId).send(corpo).expect(201);
            expect(repetida.headers["idempotent-replayed"]).toBe("true");
            expect(repetida.body).toMatchObject({
                transactionId: primeira.body.transactionId,
                balance: { amount: "6.00", currency: "BRL" },
                idempotentReplay: true,
            });

            const conflito = await http()
                .post("/wagering/transactions")
                .set("Idempotency-Key", "k-" + corpo.externalTransactionId)
                .send({ ...corpo, money: { amount: "5.00", currency: "BRL" } })
                .expect(409);
            expect(conflito.body.error).toBe("IDEMPOTENCY_CONFLICT");

            const saldo = await http().get("/wallets/" + c.id).expect(200);
            expect(saldo.body.balance).toEqual({ amount: "5.00", currency: "BRL" });
        });

        it("rejeição de negócio = 422 com failureCode", async () => {
            const c = await criarCarteira("1.00");
            const corpo = aposta(c, "BET", "2.00");
            const r = await http().post("/wagering/transactions").set("Idempotency-Key", corpo.externalTransactionId).send(corpo).expect(422);
            expect(r.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "1.00" } });
        });

        it("referência ausente = 202 PENDING_REFERENCE", async () => {
            const c = await criarCarteira("1.00");
            const corpo = aposta(c, "ROLLBACK", "1.00", { referenceExternalTransactionId: idExterno("ausente") });
            const r = await http().post("/wagering/transactions").set("Idempotency-Key", corpo.externalTransactionId).send(corpo).expect(202);
            expect(r.body.status).toBe("PENDING_REFERENCE");
        });

        it("consulta por id e por provider + id externo", async () => {
            const c = await criarCarteira("10.00");
            const corpo = aposta(c, "BET", "1.00");
            const criada = await http().post("/wagering/transactions").set("Idempotency-Key", corpo.externalTransactionId).send(corpo).expect(201);
            await http().get("/wagering/transactions/" + String(criada.body.transactionId)).expect(200);
            const porExterno = await http().get("/providers/prov-1/wagering/transactions/" + corpo.externalTransactionId).expect(200);
            expect(porExterno.body.transactionId).toBe(criada.body.transactionId);
            await http().get("/wagering/transactions/" + crypto.randomUUID()).expect(404);
        });
    });

    describe("ledger e reconciliação", () => {
        it("pagina com cursor opaco e reconcilia", async () => {
            const c = await criarCarteira("10.00");
            for (let i = 0; i < 4; i++) {
                const corpo = aposta(c, "BET", "1.00");
                await http().post("/wagering/transactions").set("Idempotency-Key", corpo.externalTransactionId).send(corpo).expect(201);
            }
            const p1 = await http().get("/wallets/" + c.id + "/ledger?limit=2").expect(200);
            expect(p1.body.items).toHaveLength(2);
            expect(p1.body.items[0]).toMatchObject({
                walletVersion: 1,
                direction: "CREDIT",
                money: { amount: "10.00", currency: "BRL" },
                balanceBefore: { amount: "0.00", currency: "BRL" },
                balanceAfter: { amount: "10.00", currency: "BRL" },
            });
            const p2 = await http().get("/wallets/" + c.id + "/ledger?limit=2&cursor=" + String(p1.body.nextCursor)).expect(200);
            const p3 = await http().get("/wallets/" + c.id + "/ledger?limit=2&cursor=" + String(p2.body.nextCursor)).expect(200);
            expect(p3.body.items).toHaveLength(1);
            expect(p3.body.nextCursor).toBeNull();
            await http().get("/wallets/" + c.id + "/ledger?cursor=lixo").expect(400);

            const rec = await http().post("/wallets/" + c.id + "/reconciliation").expect(200);
            expect(rec.body).toEqual({
                walletId: c.id,
                storedBalance: { amount: "6.00", currency: "BRL" },
                calculatedBalance: { amount: "6.00", currency: "BRL" },
                difference: { amount: "0.00", currency: "BRL" },
                consistent: true,
                checkedEntries: 5,
                walletVersion: 5,
            });
        });
    });

    describe("com autenticação ligada", () => {
        it("um provider não envia transações em nome de outro (403)", async () => {
            const comAuth = await subir((c) => ({ ...c, autenticacao: { modo: "zitadel" } }));
            try {
                const c = await criarCarteira("10.00");
                const token = await chaves.assinar({ provedorId: "prov-a", roles: { leitor: { "prov-a": "a" } } });
                const corpo = { ...aposta(c, "BET", "1.00"), providerId: "prov-b" };
                const r = await request(comAuth.getHttpServer() as Server)
                    .post("/wagering/transactions")
                    .set("Authorization", "Bearer " + token)
                    .set("Idempotency-Key", corpo.externalTransactionId)
                    .send(corpo)
                    .expect(403);
                expect(r.body.error).toBe("FORBIDDEN");
            } finally {
                await comAuth.close();
            }
        });
    });
});
