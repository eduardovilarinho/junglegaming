// Testes de domínio e aplicação
import { describe, expect, it } from "bun:test";
import { AutenticarUsuario } from "../src/application/AutenticarUsuario";
import { AutorizarAcesso } from "../src/application/AutorizarAcesso";
import { ListarGames } from "../src/application/ListarGames";
import { ObterPerfil } from "../src/application/ObterPerfil";
import { AcessoNegadoError, NaoAutenticadoError, RegraDeDominioViolada } from "../src/domain/identidade/Erros";
import { Provedor, provedorId } from "../src/domain/identidade/Provedor";
import { Role } from "../src/domain/identidade/Role";
import { Usuario } from "../src/domain/identidade/Usuario";
import type { ValidadorDeToken } from "../src/domain/identidade/ValidadorDeToken";
import { Game } from "../src/domain/games/Game";
import { RepositorioDeGamesEmMemoria } from "../src/infrastructure/persistencia/RepositorioDeGamesEmMemoria";

const provedorA = new Provedor("provedor-a");
const provedorB = new Provedor("provedor-b");
const provedorC = new Provedor("provedor-c");

const adminDaA = new Usuario({
    id: "1",
    username: "patricia",
    provedor: provedorA,
    rolesPorProvedor: {
        "provedor-a": ["admin"]
    },
});
const leitorDaB = new Usuario({
    id: "2",
    username: "eduardo",
    provedor: provedorB,
    rolesPorProvedor: {
        "provedor-b": ["leitor"]
    },
});
// Consultor do provedor C com role concedida também no A
const consultor = new Usuario({
    id: "3",
    username: "leonardo",
    provedor: provedorC,
    rolesPorProvedor: {
        "provedor-a": ["leitor"] 
    },
});

const repositorio = new RepositorioDeGamesEmMemoria([
    new Game({
            id: "game-1", nome: "Game 1", provedorId: provedorId("provedor-a")
        }),
    new Game({
            id: "game-2", nome: "Game 2", provedorId: provedorId("provedor-a")
        }),
    new Game({
            id: "game-3", nome: "Game 3", provedorId: provedorId("provedor-b")
        })
]);
const listarGames = new ListarGames(repositorio);
const ids = (lista: readonly { readonly id: string }[]): string[] => lista.map((p) => p.id);

describe("Domínio de identidade", () => {
    it("Usuario exige id e username", () => {
        expect(() => new Usuario({ id: " ", username: "x", provedor: provedorA })).toThrow(RegraDeDominioViolada); });

    it("roles valem só no provedor em que foram concedidas", () => {
        expect(adminDaA.ehAdminDe(provedorA)).toBe(true);
        expect(adminDaA.ehAdminDe(provedorB)).toBe(false);
        expect(leitorDaB.ehAdminDe()).toBe(false);
    });

    it("Provedor e Role são value objects imutáveis", () => {
        expect(new Provedor("provedor-a").equals(provedorA)).toBe(true);
        expect(new Role("ADMIN").equals(Role.ADMIN)).toBe(true);
        expect(Object.isFrozen(provedorA)).toBe(true);
        expect(() => new Provedor("")).toThrow(RegraDeDominioViolada);
    });
});

describe("Casos de uso", () => {
    it("AutenticarUsuario rejeita token ausente ou inválido", async () => {
        const falso: ValidadorDeToken = {
            validar: async (token) => {
                if (token !== "ok") throw new NaoAutenticadoError("Token inválido");
                return adminDaA;
            }
        };
        const autenticar = new AutenticarUsuario(falso);
        await expect(autenticar.executar(null)).rejects.toThrow(NaoAutenticadoError);
        await expect(autenticar.executar("x")).rejects.toThrow(NaoAutenticadoError);
        await expect(autenticar.executar("ok")).resolves.toBe(adminDaA);
    });

    it("AutorizarAcesso checa a role no provedor do usuário", () => {
        const autorizar = new AutorizarAcesso();
        expect(() => autorizar.executar(adminDaA, Role.ADMIN)).not.toThrow();
        expect(() => autorizar.executar(leitorDaB, Role.ADMIN)).toThrow(AcessoNegadoError);
        expect(() => autorizar.executar(adminDaA, Role.ADMIN, provedorB)).toThrow(AcessoNegadoError);
    });

    it("ListarGames devolve só os games do tenant do usuário", async () => {
        expect(ids(await listarGames.executar(adminDaA))).toEqual(["game-1", "game-2"]);
        expect(ids(await listarGames.executar(leitorDaB))).toEqual(["game-3"]);
    });

    it("ListarGames bloqueia acesso a outro tenant", async () => {
        await expect(listarGames.executar(leitorDaB, "provedor-a")).rejects.toThrow(AcessoNegadoError);
    });

    it("consultor com role concedida acessa o outro provedor", async () => {
        expect(ids(await listarGames.executar(consultor, "provedor-a"))).toEqual(["game-1", "game-2"]);
        await expect(listarGames.executar(consultor, "provedor-b")).rejects.toThrow(AcessoNegadoError);
    });

    it("ObterPerfil inclui o provedor e as roles nela", () => {
        expect(new ObterPerfil().executar(adminDaA)).toEqual({
            id: "1",
            usuario: "patricia",
            email: null,
            provedor: "provedor-a",
            roles: ["admin"],
            admin: true,
        });
    });
});