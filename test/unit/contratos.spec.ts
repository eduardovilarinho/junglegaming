import { describe, expect, it } from "bun:test";
import { InvalidRequestError } from "../../src/application/errors";
import { chaveDeIdempotenciaPadrao, hashDoPedido, type WagerCommand } from "../../src/application/wagering/WagerCommand";
import { codificarCursor, decodificarCursor } from "../../src/application/wallets/QueryWallets";
import { Metricas } from "../../src/infrastructure/observabilidade/Metricas";
import { lerChaveDeIdempotencia, lerMensagemDeAposta, lerPedidoDeAposta, lerPedidoDeCarteira } from "../../src/interfaces/contratos/pedidos";

// Formato do enunciado: kind e money { amount, currency }
const base = {
    providerId: "prov-1",
    externalTransactionId: "ext-1",
    kind: "BET",
    playerId: "player-1",
    walletId: "8f0b6c1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b",
    money: { amount: "10.50", currency: "BRL" },
    roundId: "round-1",
};

describe("leitura do pedido de transação", () => {
    it("aceita o formato completo e campos opcionais ausentes", () => {
        const c = lerPedidoDeAposta(base);
        expect(c).toMatchObject({ type: "BET", amount: "10.50", currency: "BRL", referenceExternalTransactionId: null, gameId: null });
    });

    it("recusa valor numérico, tipo desconhecido, campo faltando e corpo que não é objeto", () => {
        expect(() => lerPedidoDeAposta({ ...base, money: { amount: 10.5, currency: "BRL" } })).toThrow(InvalidRequestError);
        expect(() => lerPedidoDeAposta({ ...base, money: undefined })).toThrow(InvalidRequestError);
        expect(() => lerPedidoDeAposta({ ...base, kind: "DEPOSIT" })).toThrow(InvalidRequestError);
        expect(() => lerPedidoDeAposta({ ...base, walletId: undefined })).toThrow(InvalidRequestError);
        expect(() => lerPedidoDeAposta([base])).toThrow(InvalidRequestError);
        expect(() => lerPedidoDeAposta(null)).toThrow(InvalidRequestError);
    });

    it("pedido de carteira: initialBalance { amount, currency } opcional; sem ele, currency", () => {
        expect(lerPedidoDeCarteira({ playerId: "p", initialBalance: { amount: "1000.00", currency: "BRL" } })).toEqual({
            playerId: "p", currency: "BRL", initialBalance: "1000.00",
        });
        expect(lerPedidoDeCarteira({ playerId: "p", currency: "BRL" }).initialBalance).toBeNull();
        expect(() => lerPedidoDeCarteira({ playerId: "p" })).toThrow(InvalidRequestError);
        expect(() => lerPedidoDeCarteira({ playerId: "p", initialBalance: { amount: 1, currency: "BRL" } })).toThrow(InvalidRequestError);
        expect(() =>
            lerPedidoDeCarteira({ playerId: "p", currency: "USD", initialBalance: { amount: "1.00", currency: "BRL" } })
        ).toThrow(InvalidRequestError);
    });

    it("mensagem da fila: envelope com messageId, type, occurredAt e data", () => {
        const envelope = { messageId: "msg-123", type: "WagerTransactionRequested", occurredAt: "2026-07-29T15:00:00.000Z", data: base };
        const m = lerMensagemDeAposta(envelope);
        expect(m.messageId).toBe("msg-123");
        expect(m.idempotencyKey).toBe("prov-1:ext-1");
        expect(m.pedido.type).toBe("BET");
        expect(lerMensagemDeAposta({ ...envelope, data: { ...base, idempotencyKey: "k-1" } }).idempotencyKey).toBe("k-1");
        expect(() => lerMensagemDeAposta({ ...envelope, type: "Outro" })).toThrow(InvalidRequestError);
        expect(() => lerMensagemDeAposta({ ...envelope, occurredAt: "ontem" })).toThrow(InvalidRequestError);
        expect(() => lerMensagemDeAposta({ ...envelope, messageId: undefined })).toThrow(InvalidRequestError);
        expect(() => lerMensagemDeAposta(base)).toThrow(InvalidRequestError);
    });

    it("Idempotency-Key obrigatória, até 255 caracteres visíveis", () => {
        expect(lerChaveDeIdempotencia("abc-123")).toBe("abc-123");
        expect(() => lerChaveDeIdempotencia(undefined)).toThrow(InvalidRequestError);
        expect(() => lerChaveDeIdempotencia("com espaço")).toThrow(InvalidRequestError);
        expect(() => lerChaveDeIdempotencia("x".repeat(256))).toThrow(InvalidRequestError);
    });
});

describe("hash canônico do pedido (idempotência)", () => {
    const comando = lerPedidoDeAposta(base);

    it("é o mesmo para o mesmo conteúdo, mesmo com valor escrito de outro jeito", () => {
        const mesmo: WagerCommand = { ...comando, amount: "10.5" };
        expect(hashDoPedido(mesmo)).toBe(hashDoPedido(comando));
        // Mesmos campos em outra ordem
        const invertido = Object.fromEntries(Object.entries(base).reverse());
        expect(hashDoPedido(lerPedidoDeAposta(invertido))).toBe(hashDoPedido(comando));
    });

    it("muda quando qualquer campo de negócio muda (base do 409 por conteúdo divergente)", () => {
        const h = hashDoPedido(comando);
        expect(hashDoPedido({ ...comando, amount: "10.51" })).not.toBe(h);
        expect(hashDoPedido({ ...comando, roundId: "round-2" })).not.toBe(h);
        expect(hashDoPedido({ ...comando, gameId: "g-1" })).not.toBe(h);
    });

    it("chave padrão da fila é provider + id externo", () => {
        expect(chaveDeIdempotenciaPadrao(comando)).toBe("prov-1:ext-1");
    });
});

describe("cursor do ledger", () => {
    it("ida e volta, e rejeita cursor adulterado", () => {
        expect(decodificarCursor(codificarCursor(42n))).toBe(42n);
        expect(() => decodificarCursor("nao-e-cursor")).toThrow(InvalidRequestError);
        expect(() => decodificarCursor(Buffer.from('{"v":"-1"}').toString("base64url"))).toThrow(InvalidRequestError);
    });
});

describe("métricas", () => {
    it("conta por rótulo e exporta no formato do Prometheus", () => {
        const m = new Metricas();
        m.transactionSettled("BET", "PROCESSED", 12);
        m.transactionSettled("BET", "PROCESSED", 30);
        m.duplicateRequest("http");
        m.registrarAtrasoDoOutbox(1.5);
        expect(m.valor("wager_transactions_total", { type: "BET", status: "PROCESSED" })).toBe(2);
        const texto = m.render();
        expect(texto).toMatch(/wager_transactions_total\{status="PROCESSED",type="BET"\} 2/);
        expect(texto).toMatch(/wager_duplicate_requests_total\{origin="http"\} 1/);
        expect(texto).toMatch(/outbox_lag_seconds 1\.500/);
        expect(texto).toMatch(/wager_processing_latency_ms_bucket\{le="25"\} 1/);
        expect(texto).toMatch(/wager_processing_latency_ms_count 2/);
    });

    it("divergência de reconciliação gera log de erro", () => {
        const logs: string[] = [];
        const m = new Metricas((msg) => logs.push(msg));
        m.reconciliationDivergence("w-1", "9.99", "10.00");
        expect(logs).toHaveLength(1);
        expect(m.valor("wallet_reconciliation_divergences_total")).toBe(1);
    });
});
