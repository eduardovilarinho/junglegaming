import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { NaoAutenticadoError } from "../../domain/identidade/Erros";
import { Provedor } from "../../domain/identidade/Provedor";
import { Usuario } from "../../domain/identidade/Usuario";
import type { ValidadorDeToken } from "../../domain/identidade/ValidadorDeToken";

const CLAIM_ROLES = "urn:zitadel:iam:org:project:roles";
const CLAIM_ORG_ID = "urn:zitadel:iam:user:resourceowner:id";
const CLAIM_ORG_DOMINIO = "urn:zitadel:iam:user:resourceowner:primary_domain";

export interface OpcoesZitadel {
    readonly issuer: string;
    readonly audience?: string | undefined;
    readonly jwks?: JWTVerifyGetKey | undefined;
}

type RolesDoZitadel = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

function ehObjeto(valor: unknown): valor is Readonly<Record<string, unknown>> {
    return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

function ehRolesDoZitadel(valor: unknown): valor is RolesDoZitadel {
  return ehObjeto(valor) && Object.values(valor).every(ehObjeto);
}

function textoOpcional(valor: unknown): string | null {
    return typeof valor === "string" && valor.length > 0 ? valor : null;
}
export class ZitadelValidadorDeToken implements ValidadorDeToken {
    readonly #issuer: string;
    readonly #audience: string | undefined;
    readonly #jwks: JWTVerifyGetKey;

    constructor({ issuer, audience, jwks }: OpcoesZitadel) {
        this.#issuer = issuer.replace(/\/$/, "");
        this.#audience = audience;
        this.#jwks = jwks ?? createRemoteJWKSet(new URL(this.#issuer + "/oauth/v2/keys"));
    }

    async validar(token: string): Promise<Usuario> {
        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(token, this.#jwks, {
                issuer: this.#issuer,
                ...(this.#audience !== undefined && { audience: this.#audience }),
            }));
        } catch (erro: unknown) {
            const motivo = erro instanceof Error ? erro.message : String(erro);
            throw new NaoAutenticadoError("Token inválido: " + motivo);
        }
        return this.#paraUsuario(payload);
    }

    #paraUsuario(payload: JWTPayload): Usuario {
        const sub = textoOpcional(payload.sub);
        if (sub === null) throw new NaoAutenticadoError("Token sem identificação do usuário (sub)");

        const provedorId = textoOpcional(payload[CLAIM_ORG_ID]);
        if (provedorId === null) {
          throw new NaoAutenticadoError(
              "Token sem organização: peça o escopo urn:zitadel:iam:user:resourceowner no login"
          );
        }

        const rolesDoGame: unknown =
            this.#audience === undefined
                ? undefined
                : payload["urn:zitadel:iam:org:project:" + this.#audience + ":roles"];
        const rolesBrutas: unknown = rolesDoGame ?? payload[CLAIM_ROLES] ?? {};
        if (!ehRolesDoZitadel(rolesBrutas)) throw new NaoAutenticadoError("Claim de roles em formato inesperado");

        const rolesPorProvedor: Record<string, string[]> = {};
        for (const [role, organizacoes] of Object.entries(rolesBrutas)) {
            for (const idDaOrg of Object.keys(organizacoes)) {
                (rolesPorProvedor[idDaOrg] ??= []).push(role);
            }
        }

        return new Usuario({
            id: sub,
            username: textoOpcional(payload["preferred_username"]) ?? sub,
            email: textoOpcional(payload["email"]),
            provedor: new Provedor(provedorId, textoOpcional(payload[CLAIM_ORG_DOMINIO])),
            rolesPorProvedor
        });
    }
}
