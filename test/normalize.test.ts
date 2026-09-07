import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeOrder, normalizePackages, normalizeSummary } from "../src/domain/normalize.js";
import type { RawOrderDetail, RawOrderListPage, RawTrackSsrData } from "../src/shein/types.js";

// Every assertion here runs against the anonymised captures of a real account:
// the ids are fake, the money and the dates are not.

const fixture = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;

const detailOf = (name: string) => fixture<{ info: RawOrderDetail }>(name).info;
const DETAIL = detailOf("order-detail");
const TAXED = detailOf("order-detail-tax");
const ARCHIVED_DETAIL = detailOf("order-detail-archived");
const LIST = fixture<{ info: RawOrderListPage }>("order-list").info;
const ARCHIVE = fixture<{ info: RawOrderListPage }>("order-archive").info;
const TRACK = fixture<RawTrackSsrData>("track");

const summaryFor = (billno: string) => LIST.order_list?.find((order) => order.billno === billno);

describe("normalizeSummary", () => {
  test("reads the list row, whose total is only ever a formatted label", () => {
    const first = LIST.order_list?.[0];
    const summary = normalizeSummary(first!);
    expect(summary.billno).toBe(first!.billno as string);
    expect(summary.checkoutId).toBe(first!.relationBillno as string);
    expect(summary.currency).toBe("BRL");
    expect(summary.money.total).toBe(6998);
    expect(summary.money.discount).toBe(4000);
    expect(summary.goodsCount).toBe(2);
    expect(summary.status).toBe("delivered");
    expect(summary.placedAt).toBe("2026-08-14T15:38:28-03:00");
  });

  test("an archived order is flagged and still carries its money", () => {
    const summary = normalizeSummary(ARCHIVE.order_list?.[0] as never, { archived: true });
    expect(summary.archived).toBe(true);
    expect(summary.money.total).toBe(2699);
    expect(summary.status).toBe("delivered");
  });
});

describe("normalizeOrder", () => {
  const order = normalizeOrder({ detail: DETAIL, summary: summaryFor(DETAIL.billno as string) });

  test("identifies the order and the checkout that groups it", () => {
    expect(order.billno).toBe(DETAIL.billno as string);
    // Several orders of one checkout share this id — and sometimes one package.
    expect(order.checkoutId).toBe(DETAIL.relation_billno as string);
    expect(order.currency).toBe("BRL");
    expect(order.archived).toBe(false);
  });

  test("the price lines add up to the total, which is the whole point", () => {
    const sum = order.priceLines.reduce((total, line) => total + line.cents, 0);
    expect(sum).toBe(order.money.total);
    expect(order.money.total).toBe(6998);
    expect(order.priceLines.map((line) => line.type)).toContain("newSubTotal");
  });

  test("keeps the amounts the site itself names, cents as integers", () => {
    expect(order.money).toMatchObject({
      total: 6998,
      subtotal: 6998,
      retail: 10998,
      saved: 4992,
      shipping: 0,
      shippingOriginal: 992,
      installmentFee: 0,
      tax: 0,
    });
  });

  test("dates come from the two fields that carry them", () => {
    // `pay_time` exists only on the list row; the detail has `paymentTime` in ms.
    expect(order.placedAt).toBe("2026-08-14T15:38:28-03:00");
    expect(order.paidAt).toBe("2026-08-14T15:39:19-03:00");
  });

  test("reads the payment method and its label", () => {
    expect(order.payment.method).toBe("adyen-brcardinstallment");
    expect(order.payment.title).toContain("parcelamento");
    // The number of instalments does not exist anywhere in this API.
    expect(order.payment.installments).toBeNull();
  });

  test("items take their name from `product`, because the detail has none", () => {
    expect(order.items).toHaveLength(2);
    const item = order.items[0]!;
    expect(item.name).toBe("Vega delta jade");
    expect(item.quantity).toBe(1);
    expect(item.unitPrice).toBe(3499);
    expect(item.totalPrice).toBe(3499);
    expect(item.retailUnitPrice).toBe(5499);
    expect(item.attrs).toBe("Vinho / GG");
    expect(item.store?.name).toBe("Pixel E Fenix rubi");
    expect(item.packageNo).toBeTruthy();
    expect(item.trackingNumber).toBeTruthy();
    expect(item.id).toBeTruthy();
    expect(item.imageUrl).toContain("//");
  });

  test("the item totals add up to the subtotal row", () => {
    const items = order.items.reduce((total, item) => total + item.totalPrice, 0);
    expect(items).toBe(order.money.subtotal);
  });

  test("an international order carries both tax rows", () => {
    const taxed = normalizeOrder({ detail: TAXED, summary: summaryFor(TAXED.billno as string) });
    // Imposto de Importação + ICMS, which exist as rows only — there is no field.
    expect(taxed.money.tax).toBe(3516);
    expect(taxed.money.installmentFee).toBe(360);
    expect(taxed.priceLines.reduce((sum, line) => sum + line.cents, 0)).toBe(taxed.money.total);
    expect(taxed.priceLines.filter((line) => line.type === "subTax")).toHaveLength(2);
  });

  test("the address is private: absent unless asked for", () => {
    expect(order.address).toBeUndefined();
    const withAddress = normalizeOrder({ detail: DETAIL, includeAddress: true });
    expect(withAddress.address?.city).toBe("Cidade Exemplo");
    expect(withAddress.address?.postcode).toBe("00000-000");
  });

  test("an archived order's detail is an empty shell, so the list row carries it", () => {
    const summary = ARCHIVE.order_list?.[0];
    const archived = normalizeOrder({ detail: ARCHIVED_DETAIL, summary, archived: true });
    expect(archived.billno).toBe(ARCHIVED_DETAIL.billno as string);
    expect(archived.money.total).toBe(2699);
    expect(archived.items).toHaveLength(1);
    // Shein ships an archived line as an id, an image and a quantity: no name,
    // no price. Reporting that honestly beats inventing either.
    expect(archived.items[0]?.goodsId).toBeTruthy();
    expect(archived.items[0]?.name).toBeNull();
    expect(archived.items[0]?.unitPrice).toBe(0);
    expect(archived.status).toBe("delivered");
    expect(archived.archived).toBe(true);
    // Nothing is invented: the shell has no breakdown to report.
    expect(archived.priceLines).toEqual([]);
  });

  test("works with no list row at all — get_order may be the first call", () => {
    const alone = normalizeOrder({ detail: DETAIL });
    expect(alone.money.total).toBe(6998);
    expect(alone.items).toHaveLength(2);
  });
});

describe("normalizePackages", () => {
  test("reads packageMap, the source that is always there", () => {
    const packages = normalizePackages(TRACK);
    expect(packages).toHaveLength(1);
    const parcel = packages[0]!;
    expect(parcel.carrier).toBe("Imile Brazil");
    expect(parcel.trackingNumber).toBeTruthy();
    expect(parcel.packageNo).toBeTruthy();
    expect(parcel.trackUrl).toContain("imile.com");
    expect(parcel.events).toHaveLength(27);
  });

  test("events are newest first, with the markup stripped", () => {
    const [parcel] = normalizePackages(TRACK);
    const first = parcel!.events[0]!;
    expect(first.at).toMatch(/^2026-\d{2}-\d{2}T/);
    expect(first.description).not.toContain("<p>");
    expect(first.description.length).toBeGreaterThan(0);
    const times = parcel!.events.map((event) => event.at ?? "");
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("an order that never shipped has no packages, and that is not an error", () => {
    expect(normalizePackages({ packageMap: { "0": {} } })).toEqual([]);
    expect(normalizePackages({})).toEqual([]);
  });

  test("falls back to trackInfo when a page ships only that", () => {
    const single = { trackInfo: (TRACK as { packageMap: Record<string, unknown> }).packageMap["0"] };
    expect(normalizePackages(single as never)).toHaveLength(1);
  });
});
