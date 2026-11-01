import { ErroDeDominio } from "../identidade/Erros";

// Transição proibida na máquina de estados (ex.: processar uma transação já rejeitada)
export class InvalidStateTransitionError extends ErroDeDominio {}

// Operação entre valores de moedas diferentes
export class CurrencyMismatchError extends ErroDeDominio {}

// Débito maior que o saldo: nunca deve chegar aqui, as regras checam antes
export class InsufficientBalanceError extends ErroDeDominio {}
