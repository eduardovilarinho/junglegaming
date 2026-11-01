import { SQL } from "bun";
import type { UnitOfWork } from "../../src/application/ports";
import { SCHEMA_FINANCEIRO_UP } from "../../src/infrastructure/persistencia/sql/schema";
import { BunSqlUnitOfWork } from "./BunSqlUnitOfWork";

// Testes de integração usam um PostgreSQL de verdade (o do docker-compose), num banco separado.
export const URL_DO_BANCO_DE_TESTE =
    process.env["TEST_DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/jungle_gaming_test";

/** Quem abre as transações nos testes: o MikroORM (como em produção) ou o cliente nativo do Bun */
export const DRIVER = process.env["TEST_DB_DRIVER"] === "bun-sql" ? "bun-sql" : "mikro-orm";

export const INTEGRACAO_HABILITADA = process.env["INTEGRATION"] === "1";

export interface BancoDeTeste {
    /** Conexão direta, para preparar cenários e conferir resultados */
    readonly sql: SQL;
    readonly uow: UnitOfWork;
    fechar(): Promise<void>;
}

async function garantirBanco(): Promise<void> {
    const url = new URL(URL_DO_BANCO_DE_TESTE);
    const nome = url.pathname.slice(1);
    if (!/^[a-z0-9_]+$/.test(nome)) throw new Error("Nome de banco de teste inválido: " + nome);
    url.pathname = "/postgres";
    const admin = new SQL(url.toString());
    try {
        const existe = await admin.unsafe("select 1 from pg_database where datname = $1", [nome]);
        if (existe.length === 0) await admin.unsafe('create database "' + nome + '"');
    } finally {
        await admin.close();
    }
}

/** Recria o schema do zero: cada arquivo de teste começa com um banco limpo */
export async function prepararBanco(): Promise<BancoDeTeste> {
    await garantirBanco();
    // Conexão direta: pequena quando o MikroORM é quem abre as transações (o pool dele é separado);
    // maior com bun-sql, que também atende as transações concorrentes dos testes.
    // Somada às instâncias do teste de várias instâncias, precisa caber no max_connections (100 por padrão).
    const sql = new SQL({ url: URL_DO_BANCO_DE_TESTE, max: DRIVER === "bun-sql" ? 40 : 5 });
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("create schema public");
    for (const comando of SCHEMA_FINANCEIRO_UP) await sql.unsafe(comando);

    if (DRIVER === "bun-sql") {
        return { sql, uow: new BunSqlUnitOfWork(sql), fechar: () => sql.close() };
    }

    // Import dinâmico: só carrega o MikroORM quando este driver é o escolhido
    const { MikroORM } = await import("@mikro-orm/postgresql");
    const { criarConfigMikroOrm } = await import("../../src/infrastructure/persistencia/mikro-orm/mikro-orm.config.js");
    const { MikroOrmUnitOfWork } = await import("../../src/infrastructure/persistencia/mikro-orm/MikroOrmUnitOfWork.js");
    const { carregarConfiguracao } = await import("../../src/infrastructure/config.js");
    const config = carregarConfiguracao();
    const orm = await MikroORM.init(criarConfigMikroOrm({ ...config, banco: { ...config.banco, url: URL_DO_BANCO_DE_TESTE, debug: false } }));
    return {
        sql,
        uow: new MikroOrmUnitOfWork(orm.em, 5000),
        fechar: async () => {
            await orm.close(true);
            await sql.close();
        },
    };
}

/**
 * Invariante final de todos os testes:
 * - o saldo de cada carteira é igual ao saldo reconstruído a partir do ledger;
 * - a versão é 1 na criação e sobe 1 por lançamento (versão = último walletVersion, ou 1 sem lançamentos),
 *   sem buracos entre os lançamentos;
 * - os lançamentos formam uma corrente: o saldo anterior de cada um é o saldo posterior do anterior,
 *   e o último termina no saldo da carteira.
 */
export async function conferirInvariantes(sql: SQL): Promise<void> {
    const divergentes = await sql.unsafe(`
        select w.id, w.balance::text as armazenado,
               coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as calculado,
               w.version::text as versao, count(l.id)::text as lancamentos
        from wallets w left join ledger_entries l on l.wallet_id = w.id
        group by w.id
        having w.balance <> coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)
            or w.version <> coalesce(max(l.wallet_version), 1)
            or (count(l.id) > 0 and count(l.id) <> max(l.wallet_version) - min(l.wallet_version) + 1)
    `);
    if (divergentes.length > 0) throw new Error("Carteiras divergentes do ledger: " + JSON.stringify(divergentes));

    const correntesQuebradas = await sql.unsafe(`
        select wallet_id, wallet_version from (
            select wallet_id, wallet_version, balance_before,
                   lag(balance_after) over (partition by wallet_id order by wallet_version) as anterior
            from ledger_entries
        ) t
        where balance_before <> coalesce(anterior, 0)
    `);
    if (correntesQuebradas.length > 0) throw new Error("Ledger com saldo anterior incoerente: " + JSON.stringify(correntesQuebradas));

    const ultimos = await sql.unsafe(`
        select w.id from wallets w
        join lateral (select balance_after from ledger_entries where wallet_id = w.id order by wallet_version desc limit 1) u on true
        where u.balance_after <> w.balance
    `);
    if (ultimos.length > 0) throw new Error("Último lançamento não bate com o saldo: " + JSON.stringify(ultimos));
}
