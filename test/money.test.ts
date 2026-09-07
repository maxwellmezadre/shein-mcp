import { describe, expect, test } from "bun:test";
import { centsFromDecimal, centsFromFormatted, priceCents, toDecimal } from "../src/domain/money.js";

// Money is integer cents inside the tool. Shein ships it in two shapes: a
// decimal string ("69.98") in the detail, and a formatted label ("R$69,98")
// in the list and for archived orders.

describe("centsFromDecimal", () => {
  test("reads the decimal strings the api uses", () => {
    expect(centsFromDecimal("69.98")).toBe(6998);
    expect(centsFromDecimal("0.00")).toBe(0);
    expect(centsFromDecimal("1234.5")).toBe(123450);
    expect(centsFromDecimal(9.92)).toBe(992);
  });

  test("rounds instead of trusting binary floats", () => {
    // 0.615 * 100 is 61.49999… in IEEE 754; a truncation would lose a cent.
    expect(centsFromDecimal("0.615")).toBe(62);
    expect(centsFromDecimal("35.29")).toBe(3529);
  });

  test("missing or unparseable money is zero, never NaN", () => {
    expect(centsFromDecimal(undefined)).toBe(0);
    expect(centsFromDecimal(null)).toBe(0);
    expect(centsFromDecimal("")).toBe(0);
    expect(centsFromDecimal("Grátis")).toBe(0);
  });
});

describe("centsFromFormatted", () => {
  test("reads the Brazilian label, thousands separator included", () => {
    expect(centsFromFormatted("R$69,98")).toBe(6998);
    expect(centsFromFormatted("R$1.234,56")).toBe(123456);
    expect(centsFromFormatted("R$0,00")).toBe(0);
  });

  test("reads a plain label and the free-shipping wording as zero", () => {
    expect(centsFromFormatted("Grátis")).toBe(0);
    expect(centsFromFormatted("GRÁTIS")).toBe(0);
    expect(centsFromFormatted(undefined)).toBe(0);
  });

  test("survives a dot-decimal label from another storefront", () => {
    expect(centsFromFormatted("$13.77")).toBe(1377);
  });
});

describe("priceCents", () => {
  test("prefers the machine-readable amount over the label", () => {
    expect(priceCents({ amount: "69.98", amountWithSymbol: "R$69,98" })).toBe(6998);
    // The list ships the total as a bare formatted string.
    expect(priceCents("R$26,99")).toBe(2699);
    expect(priceCents(undefined)).toBe(0);
  });
});

describe("toDecimal", () => {
  test("goes back to a decimal number at the tool boundary", () => {
    expect(toDecimal(6998)).toBe(69.98);
    expect(toDecimal(0)).toBe(0);
    expect(toDecimal(-4992)).toBe(-49.92);
  });
});
