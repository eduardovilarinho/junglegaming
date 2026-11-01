import type { Request } from "express";
import type { Usuario } from "../../domain/identidade/Usuario";

export interface RequisicaoHttp extends Request {
    usuario?: Usuario;
}

export function extrairBearer(cabecalho: string | undefined): string | null {
    if (cabecalho === undefined) return null;
    const [tipo, token] = cabecalho.split(" ");
    return tipo === "Bearer" && token !== undefined && token.length > 0 ? token : null;
}
