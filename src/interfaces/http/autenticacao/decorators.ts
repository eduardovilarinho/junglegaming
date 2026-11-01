import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import { NaoAutenticadoError } from "../../../domain/identidade/Erros";
import { Role } from "../../../domain/identidade/Role";
import type { Usuario } from "../../../domain/identidade/Usuario";
import type { RequisicaoHttp } from "../requisicao";

export const CHAVE_PUBLICO = "rota:publica";
export const CHAVE_ROLES = "rota:roles";

export const Publico = (): MethodDecorator & ClassDecorator => SetMetadata(CHAVE_PUBLICO, true);
export const RolesExigidas = (...roles: readonly (Role | string)[]): MethodDecorator & ClassDecorator => SetMetadata(CHAVE_ROLES, roles.map(Role.de));
export const UsuarioAtual = createParamDecorator(
    (_dados: unknown, contexto: ExecutionContext): Usuario => {
        const requisicao = contexto.switchToHttp().getRequest<RequisicaoHttp>();
        if (requisicao.usuario === undefined) {
            throw new NaoAutenticadoError("Usuário não autenticado");
        }
        return requisicao.usuario;
    }
);

/** Usuário autenticado, ou null quando a autenticação está desativada (AUTH_MODE=disabled) */
export const UsuarioOpcional = createParamDecorator(
    (_dados: unknown, contexto: ExecutionContext): Usuario | null => {
        const requisicao = contexto.switchToHttp().getRequest<RequisicaoHttp>();
        return requisicao.usuario ?? null;
    }
);