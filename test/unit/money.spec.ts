import { describe, expect, it } from "bun:test";
import { RegraDeDominioViolada } from "../../src/domain/identidade/Erros";
import { CurrencyMismatchError } from "../../src/domain/shared/errors";
import { Currency, Money } from "../../src/domain/shared/Money";

const BRL = Currency.of("BRL");
const USD = Currency.of("USD");
const brl = (valor: string): Money => Money.fromDecimal(valor, BRL);

describe("Currency", () => {
    it("aceita só código ISO de 3 letras maiúsculas", () => {
        expect(Currency.of("BRL").code).toBe("BRL");
        for (const invalida of ["brl", "BR", "BRLL", "", "R$"]) {
            expect(() => Currency.of(invalida)).toThrow(RegraDeDominioViolada);
        }
    });
});

describe("Money", () => {
    it("lê strings decimais com até 2 casas e normaliza para 2 casas", () => {
        expect(brl("10").toDecimalString()).toBe("10.00");
        expect(brl("10.5").toDecimalString()).toBe("10.50");
        expect(brl("0.01").minorUnits).toBe(1n);
        expect(brl("0").isZero()).toBe(true);
        expect(brl("1234567890.99").minorUnits).toBe(123456789099n);
    });

    it("rejeita negativo, mais de 2 casas, expoente, sinal e lixo", () => {
        for (const invalido of ["-1", "1.001", "1e3", "+1", "1,50", "", " 1", "01", ".5", "1.", "NaN", "Infinity"]) {
            expect(() => brl(invalido)).toThrow(RegraDeDominioViolada);
        }
    });

    it("soma e subtrai sem erro de ponto flutuante", () => {
        expect(brl("0.10").add(brl("0.20")).toDecimalString()).toBe("0.30");
        expect(brl("100.00").subtract(brl("0.01")).toDecimalString()).toBe("99.99");
    });

    it("nunca fica negativo", () => {
        expect(() => brl("1.00").subtract(brl("1.01"))).toThrow(RegraDeDominioViolada);
        expect(() => Money.fromMinorUnits(-1n, BRL)).toThrow(RegraDeDominioViolada);
    });

    it("recusa operar moedas diferentes", () => {
        const usd = Money.fromDecimal("1.00", USD);
        expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
        expect(() => brl("1.00").isGreaterThanOrEqual(usd)).toThrow(CurrencyMismatchError);
        expect(brl("1.00").equals(usd)).toBe(false);
    });

    it("compara valores", () => {
        expect(brl("5.00").isGreaterThanOrEqual(brl("5"))).toBe(true);
        expect(brl("4.99").isGreaterThanOrEqual(brl("5"))).toBe(false);
        expect(brl("5").equals(brl("5.00"))).toBe(true);
    });
});
