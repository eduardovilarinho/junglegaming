export abstract class ErroDeDominio extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = new.target.name;
  }
}
export class NaoAutenticadoError extends ErroDeDominio {}
export class AcessoNegadoError extends ErroDeDominio {}
export class RegraDeDominioViolada extends ErroDeDominio {}