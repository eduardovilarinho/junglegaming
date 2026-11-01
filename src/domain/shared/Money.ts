import { RegraDeDominioViolada } from "../identidade/Erros";
import { CurrencyMismatchError } from "./errors";

const CODIGO_DE_MOEDA = /^[A-Z]{3}$/;

// Value Object: moeda ISO 4217. O modelo é multimoeda, com escala fixa de 2 casas.
export class Currency {
    static readonly SCALE = 2;

    private constructor(readonly code: string) {
        Object.freeze(this);
    }

    static of(code: string): Currency {
        if (!CODIGO_DE_MOEDA.test(code)) {
            throw new RegraDeDominioViolada("Moeda inválida: use o código ISO de 3 letras maiúsculas, ex.: BRL");
        }
        return new Currency(code);
    }

    equals(outra: Currency): boolean {
        return outra.code === this.code;
    }
}

// Decimal sem sinal, sem expoente, com até 2 casas: "10", "10.5", "10.50"
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

// Maior valor que cabe numa coluna bigint do PostgreSQL
const MAXIMO_EM_CENTAVOS = 9_223_372_036_854_775_807n;

// Value Object: dinheiro em unidades menores (centavos) com bigint.
// Nunca usa number: 0.1 + 0.2 em ponto flutuante não é 0.3.
export class Money {
    private constructor(
        readonly minorUnits: bigint,
        readonly currency: Currency
    ) {
        Object.freeze(this);
    }

    /** Lê um valor vindo de fora (API, fila). Rejeita negativos, expoente e mais de 2 casas. */
    static fromDecimal(valor: string, moeda: Currency): Money {
        if (!DECIMAL.test(valor)) {
            throw new RegraDeDominioViolada(
                'Valor monetário inválido: use uma string decimal não negativa com até 2 casas, ex.: "10.50"'
            );
        }
        const [inteira, fracao] = valor.split(".");
        const centavos = BigInt(inteira ?? "0") * 100n + BigInt((fracao ?? "").padEnd(Currency.SCALE, "0"));
        return Money.fromMinorUnits(centavos, moeda);
    }

    /** Reconstrói a partir do banco, onde o valor fica em centavos. */
    static fromMinorUnits(centavos: bigint, moeda: Currency): Money {
        if (centavos < 0n) throw new RegraDeDominioViolada("Dinheiro não pode ser negativo");
        if (centavos > MAXIMO_EM_CENTAVOS) throw new RegraDeDominioViolada("Valor monetário acima do limite suportado");
        return new Money(centavos, moeda);
    }

    static zero(moeda: Currency): Money {
        return new Money(0n, moeda);
    }

    add(outro: Money): Money {
        this.exigirMesmaMoeda(outro);
        return Money.fromMinorUnits(this.minorUnits + outro.minorUnits, this.currency);
    }

    /** Lança erro se o resultado for negativo: quem chama deve checar com isGreaterThanOrEqual antes. */
    subtract(outro: Money): Money {
        this.exigirMesmaMoeda(outro);
        return Money.fromMinorUnits(this.minorUnits - outro.minorUnits, this.currency);
    }

    isGreaterThanOrEqual(outro: Money): boolean {
        this.exigirMesmaMoeda(outro);
        return this.minorUnits >= outro.minorUnits;
    }

    isZero(): boolean {
        return this.minorUnits === 0n;
    }

    isPositive(): boolean {
        return this.minorUnits > 0n;
    }

    equals(outro: Money): boolean {
        return this.currency.equals(outro.currency) && this.minorUnits === outro.minorUnits;
    }

    /** Sempre com 2 casas: 1050n -> "10.50" */
    toDecimalString(): string {
        const texto = this.minorUnits.toString().padStart(Currency.SCALE + 1, "0");
        return texto.slice(0, -Currency.SCALE) + "." + texto.slice(-Currency.SCALE);
    }

    private exigirMesmaMoeda(outro: Money): void {
        if (!this.currency.equals(outro.currency)) {
            throw new CurrencyMismatchError(
                "Operação entre moedas diferentes: " + this.currency.code + " e " + outro.currency.code
            );
        }
    }
}
