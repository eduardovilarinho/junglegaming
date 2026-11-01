// Utilitário de teste: simula o Zitadel emitindo tokens com as mesmas claims
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export const ISSUER = "https://teste.zitadel.cloud";
export const GAME = "game-123";

export interface OpcoesDoToken {
    readonly provedorId?: string;
    readonly roles?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly semProvedor?: boolean;
    readonly audience?: string;
    readonly rolesNaClaimDoGame?: boolean;
}

export interface ChavesDeTeste {
    readonly jwks: JWTVerifyGetKey;
    assinar(opcoes: OpcoesDoToken): Promise<string>;
}

export async function criarChavesDeTeste(): Promise<ChavesDeTeste> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };

    return {
        jwks: createLocalJWKSet({ keys: [jwk] }),
        assinar: ({ provedorId = "provedor-a", roles = {}, semProvedor = false, audience = GAME, rolesNaClaimDoGame = false }) => {
            const claimDeRoles = rolesNaClaimDoGame
                ? "urn:zitadel:iam:org:project:" + GAME + ":roles"
                : "urn:zitadel:iam:org:project:roles";
            const claims: JWTPayload = {
                preferred_username: "usuario-" + provedorId,
                email: "u@" + provedorId + ".com",
                [claimDeRoles]: roles,
            };
            if (!semProvedor) claims["urn:zitadel:iam:user:resourceowner:id"] = provedorId;

            return new SignJWT(claims)
                .setProtectedHeader({ alg: "RS256", kid: "k1" })
                .setSubject("u-" + provedorId)
                .setIssuer(ISSUER)
                .setAudience(audience)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(privateKey);
        }
    };
}
