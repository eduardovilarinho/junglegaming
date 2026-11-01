import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AutorizarAcesso } from "../../../application/AutorizarAcesso";
import { NaoAutenticadoError } from "../../../domain/identidade/Erros";
import type { Role } from "../../../domain/identidade/Role";
import type { RequisicaoHttp } from "../requisicao";
import { CHAVE_ROLES } from "./decorators";

@Injectable()
export class AutorizacaoGuard implements CanActivate {
    constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AutorizarAcesso) private readonly autorizarAcesso: AutorizarAcesso
    ) {}

    canActivate(contexto: ExecutionContext): boolean {
        const roles = this.reflector.getAllAndOverride<readonly Role[] | undefined>(CHAVE_ROLES, [
            contexto.getHandler(),
            contexto.getClass(),
        ]);
        if (roles === undefined || roles.length === 0) return true;
        const { usuario } = contexto.switchToHttp().getRequest<RequisicaoHttp>();
        if (usuario === undefined) throw new NaoAutenticadoError("Usuário não autenticado");
        for (const role of roles) {
            this.autorizarAcesso.executar(usuario, role);
        }
        return true;
    }
}
