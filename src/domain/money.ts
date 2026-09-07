import type { RawPrice } from "../shein/types.js";

// Money is an integer number of cents everywhere inside the tool: a decimal
// total that came from summing floats is how a report ends up a cent off.
// Shein ships money in two shapes — a machine-readable decimal string
// (`amount: "69.98"`) and a formatted label (`"R$69,98"`, `"Grátis"`) — and the
// list endpoint ships the order total ONLY as the label.

/** `"69.98"` → 6998. Anything unparseable is 0, never NaN. */
export function centsFromDecimal(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  // Round, never truncate: 0.615 * 100 is 61.49999… in IEEE 754.
  return Math.round(parsed * 100);
}

/** `"R$1.234,56"` → 123456. `"Grátis"` and friends → 0. */
export function centsFromFormatted(label: string | null | undefined): number {
  if (!label) return 0;
  const digits = label.replace(/[^\d.,-]/g, "");
  if (digits === "" || !/\d/.test(digits)) return 0;
  // Brazilian labels use "." for thousands and "," for cents; other
  // storefronts (the USD mirror of the same payload) use the opposite.
  const normalized = digits.includes(",")
    ? digits.replace(/\./g, "").replace(",", ".")
    : digits;
  return centsFromDecimal(normalized);
}

/** The money of a field that may be an object, a label, or missing. */
export function priceCents(price: RawPrice | string | null | undefined): number {
  if (price === null || price === undefined) return 0;
  if (typeof price === "string") return centsFromFormatted(price);
  if (price.amount !== undefined && price.amount !== "") return centsFromDecimal(price.amount);
  return centsFromFormatted(price.amountWithSymbol);
}

/** Back to a decimal number, at the boundary where a tool answers. */
export const toDecimal = (cents: number): number => Math.round(cents) / 100;
