import type { Telemetry } from "../../application/Telemetry";
import type { TransactionStatus, TransactionType } from "../../domain/wagering/WagerTransaction";

type Rotulos = Readonly<Record<string, string>>;

const LIMITES_DE_LATENCIA_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

function chave(nome: string, rotulos: Rotulos): string {
    const partes = Object.keys(rotulos)
        .sort()
        .map((k) => k + '="' + String(rotulos[k]).replace(/["\\\n]/g, "_") + '"');
    return partes.length === 0 ? nome : nome + "{" + partes.join(",") + "}";
}

// Métricas em memória, expostas em GET /metrics no formato texto do Prometheus.
// Cada instância expõe as próprias; o Prometheus soma as instâncias.
// Implementa a porta Telemetry da aplicação.
export class Metricas implements Telemetry {
    readonly #contadores = new Map<string, number>();
    readonly #ajuda = new Map<string, string>();
    readonly #baldes = new Map<string, number[]>();
    readonly #somas = new Map<string, { soma: number; total: number }>();
    #atrasoDoOutbox = 0;

    constructor(private readonly aoDivergir: (mensagem: string) => void = () => undefined) {
        this.#ajuda.set("wager_transactions_total", "Transações finalizadas, por tipo e estado");
        this.#ajuda.set("wager_duplicate_requests_total", "Pedidos repetidos respondidos pela idempotência");
        this.#ajuda.set("wager_duplicate_messages_total", "Mensagens da fila já processadas (inbox)");
        this.#ajuda.set("wager_retries_total", "Novas tentativas por conflito passageiro");
        this.#ajuda.set("wager_lock_conflicts_total", "Esperas por lock que estouraram o tempo limite");
        this.#ajuda.set("wager_dlq_messages_total", "Mensagens enviadas para a DLQ");
        this.#ajuda.set("wallet_reconciliation_divergences_total", "Reconciliações com saldo divergente do ledger");
    }

    transactionSettled(tipo: TransactionType, status: TransactionStatus, latenciaMs: number): void {
        this.somar("wager_transactions_total", { type: tipo, status });
        this.observar("wager_processing_latency_ms", latenciaMs);
    }

    duplicateRequest(origem: "http" | "queue"): void {
        this.somar("wager_duplicate_requests_total", { origin: origem });
    }

    duplicateMessage(): void {
        this.somar("wager_duplicate_messages_total", {});
    }

    retry(motivo: string): void {
        this.somar("wager_retries_total", { reason: motivo });
    }

    lockConflict(): void {
        this.somar("wager_lock_conflicts_total", {});
    }

    deadLettered(): void {
        this.somar("wager_dlq_messages_total", {});
    }

    reconciliationDivergence(walletId: string, armazenado: string, calculado: string): void {
        this.somar("wallet_reconciliation_divergences_total", {});
        this.aoDivergir(
            "Divergência na carteira " + walletId + ": saldo gravado " + armazenado + ", ledger " + calculado + " (não corrigido)"
        );
    }

    /** Atualizado pelo worker do outbox a cada rodada */
    registrarAtrasoDoOutbox(segundos: number): void {
        this.#atrasoDoOutbox = segundos;
    }

    valor(nome: string, rotulos: Rotulos = {}): number {
        return this.#contadores.get(chave(nome, rotulos)) ?? 0;
    }

    /** Texto no formato de exposição do Prometheus */
    render(): string {
        const linhas: string[] = [];
        const porNome = new Map<string, string[]>();
        for (const [k, v] of this.#contadores) {
            const nome = k.split("{")[0] ?? k;
            const lista = porNome.get(nome) ?? [];
            lista.push(k + " " + String(v));
            porNome.set(nome, lista);
        }
        for (const [nome, ajuda] of this.#ajuda) {
            linhas.push("# HELP " + nome + " " + ajuda, "# TYPE " + nome + " counter");
            linhas.push(...(porNome.get(nome) ?? [nome + " 0"]));
        }

        linhas.push("# HELP outbox_lag_seconds Idade do evento mais antigo ainda não publicado");
        linhas.push("# TYPE outbox_lag_seconds gauge", "outbox_lag_seconds " + this.#atrasoDoOutbox.toFixed(3));

        const nome = "wager_processing_latency_ms";
        linhas.push("# HELP " + nome + " Latência do processamento de transações", "# TYPE " + nome + " histogram");
        const baldes = this.#baldes.get(nome) ?? LIMITES_DE_LATENCIA_MS.map(() => 0);
        LIMITES_DE_LATENCIA_MS.forEach((limite, i) => {
            linhas.push(nome + '_bucket{le="' + String(limite) + '"} ' + String(baldes.at(i) ?? 0));
        });
        const agregado = this.#somas.get(nome) ?? { soma: 0, total: 0 };
        linhas.push(nome + '_bucket{le="+Inf"} ' + String(agregado.total));
        linhas.push(nome + "_sum " + agregado.soma.toFixed(3), nome + "_count " + String(agregado.total));
        return linhas.join("\n") + "\n";
    }

    private somar(nome: string, rotulos: Rotulos): void {
        const k = chave(nome, rotulos);
        this.#contadores.set(k, (this.#contadores.get(k) ?? 0) + 1);
    }

    private observar(nome: string, valor: number): void {
        const baldes = this.#baldes.get(nome) ?? LIMITES_DE_LATENCIA_MS.map(() => 0);
        LIMITES_DE_LATENCIA_MS.forEach((limite, i) => {
            if (valor <= limite) baldes.splice(i, 1, (baldes.at(i) ?? 0) + 1);
        });
        this.#baldes.set(nome, baldes);
        const agregado = this.#somas.get(nome) ?? { soma: 0, total: 0 };
        this.#somas.set(nome, { soma: agregado.soma + valor, total: agregado.total + 1 });
    }
}
