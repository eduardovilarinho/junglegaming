// Testa a anti-corruption layer: claims do Zitadel -> Usuario do domínio.
import { beforeAll, describe, expect, it } from "bun:test";
// Assina tokens com uma chave local, sem precisar de um servidor Zitadel.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { NaoAutenticadoError } from "../src/domain/identidade/Erros";
import { Provedor } from "../src/domain/identidade/Provedor";
import { ZitadelValidadorDeToken } from "../src/infrastructure/zitadel/ZitadelValidadorDeToken";
import { type ChavesDeTeste, criarChavesDeTeste, ISSUER, GAME } from "./zitadel-de-teste";

let chaves: ChavesDeTeste;
let validador: ZitadelValidadorDeToken;

beforeAll(async () => {
    chaves = await criarChavesDeTeste();
    validador = new ZitadelValidadorDeToken({ issuer: ISSUER + "/", audience: GAME, jwks: chaves.jwks });
});

describe("ZitadelValidadorDeToken", () => {
    it("traduz organização e roles por organização", async () => {
        const usuario = await validador.validar(
            await chaves.assinar({
            provedorId: "provedor-a",
            roles: { admin: { "provedor-a": "a.x" }, leitor: { "provedor-a": "a.x", "provedor-b": "b.x" } },
            })
        );
        expect<string>(usuario.provedor.id).toBe("provedor-a");
        expect(usuario.rolesEm().map((r) => r.nome)).toEqual(["admin", "leitor"]);
        expect(usuario.rolesEm(new Provedor("provedor-b")).map((r) => r.nome)).toEqual(["leitor"]);
        expect(usuario.ehAdminDe()).toBe(true);
    });

    it("rejeita token sem organização", async () => {
        await expect(validador.validar(await chaves.assinar({ semProvedor: true }))).rejects.toThrow(/sem organização/);
    });

    it("rejeita token assinado por outra chave", async () => {
        const outras = await criarChavesDeTeste();
        await expect(validador.validar(await outras.assinar({ provedorId: "provedor-a" }))).rejects.toThrow(NaoAutenticadoError);
    });

    it("rejeita audience de outro game", async () => {
        await expect(validador.validar(await chaves.assinar({ provedorId: "provedor-a", audience: "outro-game" }))).rejects.toThrow(NaoAutenticadoError);
    });

    it("rejeita claim de roles em formato inesperado", async () => {
        const { publicKey, privateKey } = await generateKeyPair("RS256");
        const jwks = createLocalJWKSet({
            keys: [{
                ...(await exportJWK(publicKey)), kid: "k", alg: "RS256"
            }]
        });
        const v = new ZitadelValidadorDeToken({ issuer: ISSUER, jwks });
        const claims: JWTPayload = {
            "urn:zitadel:iam:user:resourceowner:id": "provedor-a",
            "urn:zitadel:iam:org:project:roles": ["admin"],
        };
        const token = await new SignJWT(claims)
            .setProtectedHeader({
                alg: "RS256", kid: "k"
            })
            .setSubject("1")
            .setIssuer(ISSUER)
            .setExpirationTime("5m")
            .sign(privateKey);
            await expect(v.validar(token)).rejects.toThrow(/formato inesperado/);
    });
    it("lê as roles da claim específica do game", async () => {
        const usuario = await validador.validar(
            await chaves.assinar({ provedorId: "provedor-a", roles: { admin: { "provedor-a": "a.x" } }, rolesNaClaimDoGame: true })
        );
        expect(usuario.ehAdminDe()).toBe(true);
    });
});
