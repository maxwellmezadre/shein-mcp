import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The repository is public and these fixtures come from a real account. This
// test is the standing guard: it fails if anything private, or anything that
// would let the money identities rot, ever gets committed.

const DIR = join(import.meta.dir, "fixtures");
const files = readdirSync(DIR).filter((name) => name.endsWith(".json"));
const blob = files.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");

describe("committed fixtures", () => {
  test("the expected captures are all present", () => {
    expect(files.sort()).toEqual([
      "order-archive.json",
      "order-detail-archived.json",
      "order-detail-tax.json",
      "order-detail.json",
      "order-list.json",
      "track.json",
      "unauth-list.json",
    ]);
  });

  test("carry no personal data", () => {
    // Patterns, not names: a guard that spells out the author's street to
    // check that it is absent has published the street. The real values live
    // in task/anonymize.secrets, which is gitignored and read below.
    expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@(?!exemplo\.test)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); // e-mail
    expect(blob).not.toMatch(/\b\d{5}-\d{3}\b(?<!00000-000)/); // CEP
    expect(blob).not.toMatch(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b(?<!000\.000\.000-00)/); // CPF
    expect(blob).not.toMatch(/\bRua (?!Exemplo)\p{Lu}/u); // a street that is not the placeholder
    for (const marker of ["sessionID_shein", "armorToken", "smdeviceid"]) {
      expect(blob).not.toContain(marker); // session and anti-bot markers
    }
  });

  test("carry none of the values the anonymiser was told to erase", () => {
    // The private list of real strings (name, city, street…) lives outside the
    // repository. When it is here, every one of them must be absent; when it is
    // not, the patterns above are the guard.
    const secretsFile = join(import.meta.dir, "..", "task", "anonymize.secrets");
    if (!existsSync(secretsFile)) return;
    const secrets = readFileSync(secretsFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 4);
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(blob.includes(secret)).toBe(false);
  });

  test("use the placeholder identity everywhere an address appears", () => {
    const detail = JSON.parse(readFileSync(join(DIR, "order-detail.json"), "utf8")) as {
      info: { shippingaddr_info: Record<string, string> };
    };
    const address = detail.info.shippingaddr_info;
    expect(address.shipping_firstname).toBe("Comprador Exemplo");
    expect(address.shipping_city).toBe("Cidade Exemplo");
    expect(address.shipping_postcode).toBe("00000-000");
    expect(address.tax_number).toBe("000.000.000-00");
  });

  test("money, quantities and dates survived the anonymisation", () => {
    const detail = JSON.parse(readFileSync(join(DIR, "order-detail.json"), "utf8")) as {
      info: {
        addTime: number;
        paymentTime: string;
        totalPrice: { amount: string };
        sorted_price: Array<{ show: string | number; amount?: string }>;
      };
    };
    const cents = (value: string | undefined) => Math.round(Number(value ?? 0) * 100);
    const shown = detail.info.sorted_price.filter((row) => String(row.show) === "1");
    // The rule the normalizer relies on, proven on the committed fixture.
    expect(shown.reduce((sum, row) => sum + cents(row.amount), 0)).toBe(cents(detail.info.totalPrice.amount));
    // A unix timestamp is 10 digits and a millisecond one is 13, exactly like
    // a tracking number: remapping ids must never have touched either.
    expect(String(detail.info.addTime)).toMatch(/^1\d{9}$/);
    expect(String(detail.info.paymentTime)).toMatch(/^1\d{12}$/);
  });

  test("the logged-out envelope is kept as the reference for a dead session", () => {
    const unauth = JSON.parse(readFileSync(join(DIR, "unauth-list.json"), "utf8")) as { code: string };
    expect(unauth.code).toBe("00101001");
  });
});
