import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DuplicateWalletError, IdempotencyConflictError } from "../../src/application/errors";
import { PublishOutbox, type EventPublisher } from "../../src/application/outbox/PublishOutbox";
import type { OutboxMessage } from "../../src/application/ports";
import { QueryWallets } from "../../src/application/wallets/QueryWallets";
import { ReconcileWallet } from "../../src/application/wallets/ReconcileWallet";
import { telemetriaVazia } from "../../src/application/Telemetry";
import { Currency, Money } from "../../src/domain/shared/Money";
import { conferirInvariantes, DRIVER, INTEGRACAO_HABILITADA, prepararBanco, type BancoDeTeste } from "../support/database";
import type { WagerCommand } from "../../src/application/wagering/WagerCommand";
import type { WagerType } from "../../src/domain/wagering/WagerTransaction";
import { casosDeUso, comando, idExterno, saldoNoBanco, telemetriaContadora, transacaoDe } from "../support/cenarios";

// Testes com PostgreSQL de verdade, com paralelismo real (várias conexões ao mesmo tempo).
// Rodar com: INTEGRATION=1 bun test test/integration  (o banco do docker-compose precisa estar no ar)
describe.skipIf(!INTEGRACAO_HABILITADA)("núcleo financeiro com PostgreSQL (" + DRIVER + ")", () => {
    let banco: BancoDeTeste;

    beforeAll(async () => {
        banco = await prepararBanco();
    });

    afterEach(async () => {
        await conferirInvariantes(banco.sql);
    });

    afterAll(async () => {
        await banco.fechar();
    });

    // Cada carteira tem um jogador próprio; cmd() monta o comando com o jogador certo
    const jogadores = new Map<string, string>();

    async function novaCarteira(saldo: string, player = "player-1", moeda = "BRL"): Promise<string> {
        const { criarCarteira } = casosDeUso(banco.uow);
        const w = await criarCarteira.execute({ playerId: player, currency: moeda, initialBalance: saldo });
        jogadores.set(w.id, player);
        return w.id;
    }

    function cmd(walletId: string, tipo: WagerType, valor: string, extra: Partial<WagerCommand> = {}): WagerCommand {
        return comando(walletId, tipo, valor, { playerId: jogadores.get(walletId) ?? "player-1", ...extra });
    }

    describe("schema e constraints", () => {
        it("o banco recusa saldo negativo mesmo por SQL direto", async () => {
            const id = await novaCarteira("1.00", idExterno("p"));
            await expect(banco.sql.unsafe("update wallets set balance = -1 where id = $1", [id])).rejects.toThrow();
        });

        it("o ledger não aceita UPDATE nem DELETE", async () => {
            const id = await novaCarteira("5.00", idExterno("p"));
            await expect(banco.sql.unsafe("update ledger_entries set amount = 1 where wallet_id = $1", [id])).rejects.toThrow();
            await expect(banco.sql.unsafe("delete from ledger_entries where wallet_id = $1", [id])).rejects.toThrow();
        });

        it("uma carteira por jogador e moeda", async () => {
            const player = idExterno("p");
            await novaCarteira("0", player);
            const { criarCarteira } = casosDeUso(banco.uow);
            await expect(criarCarteira.execute({ playerId: player, currency: "BRL", initialBalance: null })).rejects.toBeInstanceOf(DuplicateWalletError);
            await novaCarteira("0", player, "USD");
        });

        it("saldo inicial cria transação OPENING e crédito no mesmo commit, com a carteira na versão 1", async () => {
            const id = await novaCarteira("100.00", idExterno("p"));
            const [opening] = await banco.sql.unsafe("select type, status from wager_transactions where wallet_id = $1", [id]);
            expect(opening).toMatchObject({ type: "OPENING", status: "PROCESSED" });
            expect(await saldoNoBanco(banco.sql, id)).toBe("10000");
            const [carteira] = await banco.sql.unsafe("select version::int as v from wallets where id = $1", [id]);
            expect(carteira).toEqual({ v: 1 });
            const [lancamento] = await banco.sql.unsafe(
                "select wallet_version::int as v, balance_before::int as antes, balance_after::int as depois from ledger_entries where wallet_id = $1",
                [id]
            );
            expect(lancamento).toEqual({ v: 1, antes: 0, depois: 10000 });
        });

        it("o banco recusa lançamento com saldo anterior ± valor diferente do saldo posterior", async () => {
            const comSaldo = await novaCarteira("5.00", idExterno("p"));
            const vazia = await novaCarteira("0", idExterno("p"));
            const [t] = await banco.sql.unsafe("select id from wager_transactions where wallet_id = $1", [comSaldo]);
            const inserir = (antes: number, depois: number) =>
                banco.sql.unsafe(
                    `insert into ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, balance_before, balance_after, currency, created_at)
                     values (gen_random_uuid(), $1, $2, 2, 'DEBIT', 100, $3, $4, 'BRL', now())`,
                    [vazia, (t as { id: string }).id, antes, depois]
                );
            // 500 - 100 = 400, não 450: a CHECK do banco recusa
            await expect(inserir(500, 450)).rejects.toThrow(/ledger_entries_balance_arithmetic/);
        });

        it("atomicidade: erro no meio da transação não deixa nada gravado", async () => {
            const id = await novaCarteira("10.00", idExterno("p"));
            const antes = await banco.sql.unsafe("select count(*)::int as n from ledger_entries");
            const falha = banco.uow.run(async (ctx) => {
                const w = await ctx.wallets.lockById(id);
                if (w === null) throw new Error("carteira sumiu");
                const versao = w.version;
                const mudanca = w.debit(Money.fromDecimal("1.00", Currency.of("BRL")), crypto.randomUUID(), new Date());
                await ctx.wallets.saveBalance(w, versao);
                // o lançamento aponta para uma transação que não existe: a FK falha e tudo é desfeito
                await ctx.ledger.append(mudanca.entry);
            });
            await expect(falha).rejects.toThrow();
            expect(await saldoNoBanco(banco.sql, id)).toBe("1000");
            const depois = await banco.sql.unsafe("select count(*)::int as n from ledger_entries");
            expect(depois).toEqual(antes);
        });
    });

    describe("idempotência", () => {
        it("mesma chave e mesmo conteúdo devolve o resultado original com replayed", async () => {
            const id = await novaCarteira("50.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const pedido = cmd(id, "BET", "10.00");
            const primeiro = transacaoDe(await processar.execute({ command: pedido, idempotencyKey: "k-" + pedido.externalTransactionId, origin: "http" }));
            const segundo = await processar.execute({ command: pedido, idempotencyKey: "k-" + pedido.externalTransactionId, origin: "http" });
            expect(segundo).toMatchObject({ kind: "completed", replayed: true });
            expect(transacaoDe(segundo).id).toBe(primeiro.id);
            expect(await saldoNoBanco(banco.sql, id)).toBe("4000");
        });

        it("repetição devolve o saldo observado na primeira vez, mesmo depois de outras transações", async () => {
            const id = await novaCarteira("50.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const pedido = cmd(id, "BET", "10.00");
            const chave = "k-" + pedido.externalTransactionId;
            const primeiro = transacaoDe(await processar.execute({ command: pedido, idempotencyKey: chave, origin: "http" }));
            expect(primeiro.balanceAfter?.toDecimalString()).toBe("40.00");
            const outro = cmd(id, "BET", "5.00");
            await processar.execute({ command: outro, idempotencyKey: outro.externalTransactionId, origin: "http" });
            const repetido = transacaoDe(await processar.execute({ command: pedido, idempotencyKey: chave, origin: "http" }));
            expect(repetido.balanceAfter?.toDecimalString()).toBe("40.00");
            // rejeição também guarda o saldo observado
            const semSaldo = cmd(id, "BET", "999.00");
            const rejeitado = transacaoDe(await processar.execute({ command: semSaldo, idempotencyKey: semSaldo.externalTransactionId, origin: "http" }));
            expect(rejeitado).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
            expect(rejeitado.balanceAfter?.toDecimalString()).toBe("35.00");
        });

        it("mesma chave com conteúdo diferente é conflito", async () => {
            const id = await novaCarteira("50.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const pedido = cmd(id, "BET", "10.00");
            await processar.execute({ command: pedido, idempotencyKey: "kc-" + pedido.externalTransactionId, origin: "http" });
            await expect(
                processar.execute({ command: { ...pedido, amount: "11.00" }, idempotencyKey: "kc-" + pedido.externalTransactionId, origin: "http" })
            ).rejects.toBeInstanceOf(IdempotencyConflictError);
        });

        it("mesmo id externo com outra chave devolve o original; com outro conteúdo, conflito", async () => {
            const id = await novaCarteira("50.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const pedido = cmd(id, "BET", "5.00");
            const original = transacaoDe(await processar.execute({ command: pedido, idempotencyKey: "a-" + pedido.externalTransactionId, origin: "http" }));
            const repetido = await processar.execute({ command: pedido, idempotencyKey: "b-" + pedido.externalTransactionId, origin: "http" });
            expect(transacaoDe(repetido).id).toBe(original.id);
            await expect(
                processar.execute({ command: { ...pedido, amount: "6.00" }, idempotencyKey: "c-" + pedido.externalTransactionId, origin: "http" })
            ).rejects.toBeInstanceOf(IdempotencyConflictError);
        });

        it("mensagem repetida da fila é descartada pela inbox", async () => {
            const id = await novaCarteira("50.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const pedido = cmd(id, "BET", "5.00");
            const inbox = { consumer: "wager-consumer", messageId: crypto.randomUUID() };
            await processar.execute({ command: pedido, idempotencyKey: "q-" + pedido.externalTransactionId, inbox, origin: "queue" });
            const segunda = await processar.execute({ command: pedido, idempotencyKey: "q-" + pedido.externalTransactionId, inbox, origin: "queue" });
            expect(segunda.kind).toBe("duplicate-message");
            expect(await saldoNoBanco(banco.sql, id)).toBe("4500");
        });
    });

    describe("concorrência", () => {
        it("50 BETs idênticos em paralelo geram um único débito", async () => {
            const id = await novaCarteira("100.00", idExterno("p"));
            const telemetria = telemetriaContadora();
            const { processar } = casosDeUso(banco.uow, telemetria);
            const pedido = cmd(id, "BET", "10.00");
            const chave = "par-" + pedido.externalTransactionId;
            const resultados = await Promise.all(
                Array.from({ length: 50 }, () => processar.execute({ command: pedido, idempotencyKey: chave, origin: "http" }))
            );
            const ids = new Set(resultados.map((r) => transacaoDe(r).id));
            expect(ids.size).toBe(1);
            expect(resultados.filter((r) => r.kind === "completed" && !r.replayed)).toHaveLength(1);
            expect(telemetria.contagem["duplicateRequest"]).toBe(49);
            expect(await saldoNoBanco(banco.sql, id)).toBe("9000");
            const [debitos] = await banco.sql.unsafe("select count(*)::int as n from ledger_entries where wallet_id = $1 and direction = 'DEBIT'", [id]);
            expect(debitos).toEqual({ n: 1 });
        });

        it("cenário do enunciado: saldo 100.00 e dois BETs simultâneos de 80.00", async () => {
            const id = await novaCarteira("100.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const pedidos = [cmd(id, "BET", "80.00"), cmd(id, "BET", "80.00")];
            const executar = () =>
                Promise.all(pedidos.map((p) => processar.execute({ command: p, idempotencyKey: p.externalTransactionId, origin: "http" })));
            const estados = (await executar()).map((r) => transacaoDe(r));
            expect(estados.filter((t) => t.status === "PROCESSED")).toHaveLength(1);
            expect(estados.filter((t) => t.status === "REJECTED" && t.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(1);
            expect(await saldoNoBanco(banco.sql, id)).toBe("2000");
            // Repetir os dois pedidos (retentativa do provider) não duplica o débito
            await executar();
            expect(await saldoNoBanco(banco.sql, id)).toBe("2000");
            const [debitos] = await banco.sql.unsafe(
                "select count(*)::int as n from ledger_entries where wallet_id = $1 and direction = 'DEBIT'",
                [id]
            );
            expect(debitos).toEqual({ n: 1 });
        });

        it("disputa na mesma carteira: 100 BETs de 1.00 com saldo 60.00 aprovam exatamente 60", async () => {
            const id = await novaCarteira("60.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const resultados = await Promise.all(
                Array.from({ length: 100 }, () => {
                    const pedido = cmd(id, "BET", "1.00");
                    return processar.execute({ command: pedido, idempotencyKey: pedido.externalTransactionId, origin: "http" });
                })
            );
            const estados = resultados.map((r) => transacaoDe(r));
            expect(estados.filter((t) => t.status === "PROCESSED")).toHaveLength(60);
            expect(estados.filter((t) => t.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(40);
            expect(await saldoNoBanco(banco.sql, id)).toBe("0");
        });

        it("carteiras diferentes em paralelo não interferem", async () => {
            const carteiras = await Promise.all(Array.from({ length: 10 }, () => novaCarteira("20.00", idExterno("p"))));
            const { processar } = casosDeUso(banco.uow);
            await Promise.all(
                carteiras.flatMap((id) =>
                    Array.from({ length: 10 }, () => {
                        const pedido = cmd(id, "BET", "1.50");
                        return processar.execute({ command: pedido, idempotencyKey: pedido.externalTransactionId, origin: "http" });
                    })
                )
            );
            for (const id of carteiras) expect(await saldoNoBanco(banco.sql, id)).toBe("500");
        });

        it("BET, WIN e ROLLBACK misturados em paralelo mantêm saldo e ledger iguais", async () => {
            const id = await novaCarteira("100.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const bets = Array.from({ length: 20 }, () => cmd(id, "BET", "2.00"));
            await Promise.all(bets.map((b) => processar.execute({ command: b, idempotencyKey: b.externalTransactionId, origin: "http" })));
            await Promise.all([
                ...bets.slice(0, 10).map((b) => {
                    const rb = cmd(id, "ROLLBACK", "2.00", { referenceExternalTransactionId: b.externalTransactionId });
                    return processar.execute({ command: rb, idempotencyKey: rb.externalTransactionId, origin: "http" });
                }),
                ...Array.from({ length: 10 }, () => {
                    const win = cmd(id, "WIN", "3.00");
                    return processar.execute({ command: win, idempotencyKey: win.externalTransactionId, origin: "http" });
                }),
            ]);
            // 100 - 40 (bets) + 20 (rollbacks) + 30 (wins) = 110
            expect(await saldoNoBanco(banco.sql, id)).toBe("11000");
        });

        it("duas reversões concorrentes do mesmo BET: só uma é aplicada", async () => {
            const id = await novaCarteira("10.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const bet = cmd(id, "BET", "10.00");
            await processar.execute({ command: bet, idempotencyKey: bet.externalTransactionId, origin: "http" });
            const reversoes = [
                cmd(id, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }),
                cmd(id, "ROLLBACK", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }),
            ];
            const r = await Promise.all(reversoes.map((c) => processar.execute({ command: c, idempotencyKey: c.externalTransactionId, origin: "http" })));
            const estados = r.map((x) => transacaoDe(x));
            expect(estados.filter((t) => t.status === "PROCESSED")).toHaveLength(1);
            expect(estados.filter((t) => t.failureCode === "ALREADY_REVERSED")).toHaveLength(1);
            expect(await saldoNoBanco(banco.sql, id)).toBe("1000");
        });
    });

    describe("referência fora de ordem", () => {
        it("ROLLBACK antes do BET fica pendente e o worker aplica quando o BET chega", async () => {
            const id = await novaCarteira("20.00", idExterno("p"));
            const { processar, retomarPendentes } = casosDeUso(banco.uow);
            const betExterno = idExterno("bet-tardio");
            const rb = cmd(id, "ROLLBACK", "5.00", { referenceExternalTransactionId: betExterno });
            const pendente = transacaoDe(await processar.execute({ command: rb, idempotencyKey: rb.externalTransactionId, origin: "http" }));
            expect(pendente.status).toBe("PENDING_REFERENCE");

            const bet = { ...cmd(id, "BET", "5.00"), externalTransactionId: betExterno };
            await processar.execute({ command: bet, idempotencyKey: betExterno, origin: "http" });
            expect(await saldoNoBanco(banco.sql, id)).toBe("1500");

            await Bun.sleep(30);
            await retomarPendentes.execute(10);
            const [linha] = await banco.sql.unsafe("select status from wager_transactions where id = $1", [pendente.id]);
            expect(linha).toEqual({ status: "PROCESSED" });
            expect(await saldoNoBanco(banco.sql, id)).toBe("2000");
        });

        it("referência que nunca chega vira REFERENCE_NOT_FOUND e publica o evento", async () => {
            const id = await novaCarteira("20.00", idExterno("p"));
            const { processar, retomarPendentes } = casosDeUso(banco.uow);
            const rb = cmd(id, "REFUND", "5.00", { referenceExternalTransactionId: idExterno("nunca") });
            const pendente = transacaoDe(await processar.execute({ command: rb, idempotencyKey: rb.externalTransactionId, origin: "http" }));
            for (let i = 0; i < 6; i++) {
                await Bun.sleep(50);
                await retomarPendentes.execute(100);
            }
            const [linha] = await banco.sql.unsafe("select status, failure_code from wager_transactions where id = $1", [pendente.id]);
            expect(linha).toEqual({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
            const eventos = await banco.sql.unsafe(
                "select event_type from outbox_events where aggregate_id = $1 order by occurred_at", [pendente.id]
            );
            expect(eventos.map((e: { event_type: string }) => e.event_type)).toEqual([
                "WagerTransactionPendingReference",
                "WagerTransactionRejected",
            ]);
        });

        it("vários workers em paralelo não processam a mesma pendência duas vezes", async () => {
            const id = await novaCarteira("50.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            const bets = Array.from({ length: 15 }, () => ({ ...cmd(id, "BET", "1.00"), externalTransactionId: idExterno("b") }));
            for (const b of bets) {
                const rb = cmd(id, "ROLLBACK", "1.00", { referenceExternalTransactionId: b.externalTransactionId });
                await processar.execute({ command: rb, idempotencyKey: rb.externalTransactionId, origin: "http" });
            }
            for (const b of bets) await processar.execute({ command: b, idempotencyKey: b.externalTransactionId, origin: "http" });
            await Bun.sleep(30);
            await Promise.all(Array.from({ length: 4 }, () => casosDeUso(banco.uow).retomarPendentes.execute(100)));
            expect(await saldoNoBanco(banco.sql, id)).toBe("5000");
        });
    });

    describe("outbox", () => {
        it("eventos só aparecem depois do commit e cada um é publicado uma vez, mesmo com publicadores concorrentes", async () => {
            const id = await novaCarteira("30.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            for (let i = 0; i < 12; i++) {
                const b = cmd(id, "BET", "1.00");
                await processar.execute({ command: b, idempotencyKey: b.externalTransactionId, origin: "http" });
            }
            const publicados: string[] = [];
            const publisher: EventPublisher = {
                publish: async (mensagens: readonly OutboxMessage[]) => {
                    await Bun.sleep(2);
                    publicados.push(...mensagens.map((m) => m.id));
                    return { publicados: mensagens.map((m) => m.id), falhas: [] };
                },
            };
            const relogio = () => new Date();
            const publicadores = Array.from({ length: 3 }, () => new PublishOutbox(banco.uow, publisher, relogio, 5));
            // Os três publicadores rodam juntos até não sobrar nada (o outbox tem eventos dos testes anteriores)
            for (;;) {
                const publicadosNaRodada = (await Promise.all(publicadores.map((p) => p.execute()))).reduce((a, b) => a + b, 0);
                if (publicadosNaRodada === 0) break;
            }

            const [pendentes] = await banco.sql.unsafe("select count(*)::int as n from outbox_events where published_at is null");
            expect(pendentes).toEqual({ n: 0 });
            expect(new Set(publicados).size).toBe(publicados.length);
        });

        it("falha parcial no lote: só os aceitos ficam publicados, os outros voltam com nova tentativa", async () => {
            await novaCarteira("1.00", idExterno("p"));
            await novaCarteira("1.00", idExterno("p"));
            let rejeitado = "";
            const metade: EventPublisher = {
                publish: async (mensagens) => {
                    const [primeiro, ...resto] = mensagens;
                    rejeitado = primeiro?.id ?? "";
                    return { publicados: resto.map((m) => m.id), falhas: primeiro === undefined ? [] : [{ id: primeiro.id, motivo: "recusado" }] };
                },
            };
            await new PublishOutbox(banco.uow, metade, () => new Date(), 500).execute();
            const [evento] = await banco.sql.unsafe("select published_at is null as pendente, attempts, last_error from outbox_events where id = $1", [rejeitado]);
            expect(evento).toEqual({ pendente: true, attempts: 1, last_error: "recusado" });
        });

        it("falha ao publicar agenda nova tentativa sem perder o evento", async () => {
            await novaCarteira("1.00", idExterno("p"));
            const falho: EventPublisher = { publish: async () => { throw new Error("fila fora do ar"); } };
            await new PublishOutbox(banco.uow, falho, () => new Date(), 500).execute();
            const [falhos] = await banco.sql.unsafe("select count(*)::int as n from outbox_events where published_at is null and attempts > 0");
            expect((falhos as { n: number }).n).toBeGreaterThan(0);
        });
    });

    describe("consultas e reconciliação", () => {
        it("paginação do ledger por cursor é estável", async () => {
            const id = await novaCarteira("10.00", idExterno("p"));
            const { processar } = casosDeUso(banco.uow);
            for (let i = 0; i < 6; i++) {
                const b = cmd(id, "BET", "1.00");
                await processar.execute({ command: b, idempotencyKey: b.externalTransactionId, origin: "http" });
            }
            const consultas = new QueryWallets(banco.uow);
            const p1 = await consultas.getLedger(id, null, 3);
            expect(p1.items.map((e) => e.walletVersion)).toEqual([1, 2, 3]);
            expect(p1.nextCursor).not.toBeNull();
            const p2 = await consultas.getLedger(id, p1.nextCursor, 3);
            expect(p2.items.map((e) => e.walletVersion)).toEqual([4, 5, 6]);
            const p3 = await consultas.getLedger(id, p2.nextCursor, 3);
            expect(p3.items.map((e) => e.walletVersion)).toEqual([7]);
            expect(p3.nextCursor).toBeNull();
        });

        it("reconciliação aponta divergência sem corrigir", async () => {
            const id = await novaCarteira("10.00", idExterno("p"));
            const divergencias: string[] = [];
            const reconciliar = new ReconcileWallet(banco.uow, { ...telemetriaVazia, reconciliationDivergence: (w) => divergencias.push(w) });
            expect(await reconciliar.execute(id)).toMatchObject({
                consistent: true,
                checkedEntries: 1,
                storedBalance: { amount: "10.00", currency: "BRL" },
                calculatedBalance: { amount: "10.00", currency: "BRL" },
            });

            await banco.sql.unsafe("update wallets set balance = 999 where id = $1", [id]);
            const r = await reconciliar.execute(id);
            expect(r).toMatchObject({
                consistent: false,
                storedBalance: { amount: "9.99" },
                calculatedBalance: { amount: "10.00" },
                difference: { amount: "-0.01", currency: "BRL" },
            });
            expect(divergencias).toEqual([id]);
            expect(await saldoNoBanco(banco.sql, id)).toBe("999");
            const [relatorio] = await banco.sql.unsafe("select consistent from reconciliation_reports where wallet_id = $1 order by created_at desc limit 1", [id]);
            expect(relatorio).toEqual({ consistent: false });
            // desfaz a adulteração para a checagem de invariantes do afterEach
            await banco.sql.unsafe("update wallets set balance = 1000 where id = $1", [id]);
        });
    });
});
