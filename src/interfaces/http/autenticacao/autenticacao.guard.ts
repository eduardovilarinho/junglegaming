import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AutenticarUsuario } from "../../../application/AutenticarUsuario";
import type { Configuracao } from "../../../infrastructure/config";
import { enriquecerContexto } from "../../../infrastructure/observabilidade/contexto";
import { extrairBearer, type RequisicaoHttp } from "../requisicao";
import { CONFIGURACAO } from "../tokens";
import { CHAVE_PUBLICO } from "./decorators";

// Guard global: toda rota exige token, a menos que esteja marcada com @Publico()
// ou que a autenticação esteja desativada (AUTH_MODE=disabled).
@Injectable()
export class AutenticacaoGuard implements CanActivate {
    constructor(
        @Inject(Reflector) private readonly reflector: Reflector,
        @Inject(AutenticarUsuario) private readonly autenticarUsuario: AutenticarUsuario,
        @Inject(CONFIGURACAO) private readonly config: Configuracao
    ) {}

    async canActivate(contexto: ExecutionContext): Promise<boolean> {
        const publica = this.reflector.getAllAndOverride<boolean | undefined>(CHAVE_PUBLICO, [
            contexto.getHandler(),
            contexto.getClass(),
        ]);
        if (publica === true) return true;
        // Ponto de extensão: sem autenticação, as rotas abrem sem usuário (@UsuarioOpcional() recebe null)
        if (this.config.autenticacao.modo === "desativada") return true;

        const requisicao = contexto.switchToHttp().getRequest<RequisicaoHttp>();
        const token = extrairBearer(requisicao.headers.authorization);
        requisicao.usuario = await this.autenticarUsuario.executar(token);
        enriquecerContexto({ providerId: requisicao.usuario.provedor.id });
        return true;
    }
}
