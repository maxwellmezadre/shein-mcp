import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractTrackSsrData } from "../../src/shein/gbdata.js";

// Golden corpus over the RAW captures (task/captures/, gitignored). It asserts
// against the untouched payloads, so it catches anything the anonymiser might
// have papered over. Skips itself when the captures are not on this machine.

const DIR = join(import.meta.dir, "..", "..", "task", "captures");
const available = existsSync(join(DIR, "list-p1.json"));
const gated = available ? describe : describe.skip;

const read = (name: string): string => readFileSync(join(DIR, name), "utf8");
const load = <T,>(name: string): T => JSON.parse(read(name)) as T;
const cents = (value: unknown): number => Math.round(Number(value ?? 0) * 100);

type Envelope<T> = { code: string; info: T };
type Detail = {
  billno?: string;
  totalPrice?: { amount: string };
  sorted_price?: Array<{ type?: string; show?: string | number; amount?: string }>;
};

const detailFiles = () => (available ? readdirSync(DIR).filter((name) => name.startsWith("detail-")) : []);

gated("raw captures", () => {
  test("every order detail adds up: total is the sum of the shown price rows", () => {
    let checked = 0;
    for (const file of detailFiles()) {
      const info = load<Envelope<Detail>>(file).info;
      if (!info?.billno) continue;
      const shown = (info.sorted_price ?? []).filter((row) => String(row.show) === "1");
      expect(shown.reduce((sum, row) => sum + cents(row.amount), 0)).toBe(cents(info.totalPrice?.amount));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("the server caps the page size at 20 and ignores the status tab", () => {
    const big = load<Envelope<{ order_list: unknown[] }>>("list-limit-50.json");
    expect(big.info.order_list).toHaveLength(20);
    // Every tab answers the same page, byte for byte: filtering is ours to do.
    expect(read("list-status-3.json")).toBe(read("list-p1.json"));
  });

  test("a logged-out caller gets code 00101001, not a redirect, on the json api", () => {
    expect(load<{ code: string }>("unauth-list.json").code).toBe("00101001");
    // The SSR page is the reliable signal: the client classified it as a dead session.
    expect(read("unauth-ssr-list.html")).toContain("redirecionou para a página de login");
  });

  test("every tracking page carries its blob; an unshipped order simply has no timeline", () => {
    const files = readdirSync(DIR).filter((name) => name.startsWith("track-"));
    expect(files.length).toBeGreaterThan(0);
    let withTimeline = 0;
    for (const file of files) {
      const blob = extractTrackSsrData(read(file)) as {
        trackInfo?: { logistics_tracks_list?: unknown[] } | null;
        packageMap?: Record<string, unknown>;
      } | null;
      expect(blob).not.toBeNull();
      // One object, never a list: the multi-package case lives in packageMap,
      // which is keyed by index ("0", "1"), not by package number.
      expect(Array.isArray(blob?.trackInfo)).toBe(false);
      if (blob?.packageMap) expect(Object.keys(blob.packageMap).every((key) => /^\d+$/.test(key))).toBe(true);
      // packageMap is the source of truth, and trackInfo is a redundant copy
      // of its first entry: 13 of 21 pages have both and they are identical,
      // while the other 8 (orders that never shipped) have NO trackInfo and an
      // empty packageMap entry. Reading packageMap covers every case.
      const packages = Object.values(blob?.packageMap ?? {}) as Array<{ logistics_tracks_list?: unknown[] }>;
      if (blob?.trackInfo) expect(JSON.stringify(packages[0])).toBe(JSON.stringify(blob.trackInfo));
      const timeline = packages[0]?.logistics_tracks_list;
      if (Array.isArray(timeline) && timeline.length > 0) withTimeline += 1;
    }
    expect(withTimeline).toBeGreaterThan(0);
    // And the empty case really happens, so the parser must survive it.
    expect(withTimeline).toBeLessThan(files.length);
  });

  test("orders of one checkout share a relation billno, and may share one package", () => {
    const list = load<Envelope<{ order_list: Array<{ billno: string; relationBillno?: string; order_package_info_list?: Array<{ packageNo?: string }> }> }>>("list-p1.json");
    const groups = new Map<string, string[]>();
    for (const order of list.info.order_list) {
      const key = order.relationBillno ?? order.billno;
      groups.set(key, [...(groups.get(key) ?? []), order.billno]);
    }
    // The account really does have multi-order checkouts; the key is not decorative.
    expect([...groups.values()].some((billnos) => billnos.length > 1)).toBe(true);
    const packages = list.info.order_list.map((order) => order.order_package_info_list?.[0]?.packageNo).filter(Boolean);
    expect(new Set(packages).size).toBeLessThan(packages.length);
  });
});
