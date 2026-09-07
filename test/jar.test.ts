import { describe, expect, test } from "bun:test";
import {
  type Cookie,
  cookieHeader,
  findCookie,
  hostMatches,
  inSiteDomain,
  memberIdFromJar,
  mergeSetCookie,
} from "../src/session/jar.js";

const NOW_MS = 1_757_000_000_000; // 2026-09-04T14:13:20Z
const NOW_S = Math.floor(NOW_MS / 1000);

function cookie(partial: Partial<Cookie> & Pick<Cookie, "name" | "value">): Cookie {
  return {
    domain: ".shein.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    ...partial,
  };
}

describe("hostMatches", () => {
  test("matches the domain itself and its subdomains, with or without the leading dot", () => {
    expect(hostMatches("br.shein.com", ".shein.com")).toBe(true);
    expect(hostMatches("shein.com", "shein.com")).toBe(true);
    expect(hostMatches("br.shein.com", "shein.com")).toBe(true);
  });

  test("does not match a different registrable domain", () => {
    expect(hostMatches("shein.com.br", ".shein.com")).toBe(false);
    expect(hostMatches("evilshein.com", "shein.com")).toBe(false);
  });
});

describe("cookieHeader", () => {
  const url = new URL("https://br.shein.com/bff-api/order/list?page=1");

  test("keeps only cookies that apply to the request", () => {
    const jar = [
      cookie({ name: "keep", value: "1" }),
      cookie({ name: "other_domain", value: "2", domain: ".shein.com.br" }),
      cookie({ name: "other_path", value: "3", path: "/nope" }),
      cookie({ name: "expired", value: "4", expires: NOW_S - 1 }),
      cookie({ name: "alive", value: "5", expires: NOW_S + 60 }),
      cookie({ name: "host_only", value: "6", domain: "br.shein.com" }),
    ];
    expect(cookieHeader(jar, url, NOW_MS)).toBe("keep=1; alive=5; host_only=6");
  });

  test("holds secure cookies back from a plain-http request", () => {
    const jar = [cookie({ name: "s", value: "1" }), cookie({ name: "p", value: "2", secure: false })];
    expect(cookieHeader(jar, new URL("http://br.shein.com/x"), NOW_MS)).toBe("p=2");
  });
});

describe("mergeSetCookie", () => {
  test("inserts a new cookie and reports the change", () => {
    const result = mergeSetCookie([], ["sessionID_shein=s%3Aabc; Path=/; HttpOnly; Secure"], "br.shein.com", NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]?.name).toBe("sessionID_shein");
    expect(result.cookies[0]?.domain).toBe("br.shein.com");
    expect(result.cookies[0]?.httpOnly).toBe(true);
  });

  test("replaces a renewed cookie value", () => {
    const jar = [cookie({ name: "AT", value: "old", domain: "br.shein.com" })];
    const result = mergeSetCookie(jar, ["AT=new; Path=/"], "br.shein.com", NOW_MS);
    expect(result.changed).toBe(true);
    expect(findCookie(result.cookies, "AT")?.value).toBe("new");
  });

  test("reports changed=false when the response repeats the same cookie", () => {
    const jar = [cookie({ name: "a", value: "1", domain: "br.shein.com", secure: false })];
    const result = mergeSetCookie(jar, ["a=1; Path=/"], "br.shein.com", NOW_MS);
    expect(result.changed).toBe(false);
  });

  test("removes a cookie killed by Max-Age=0", () => {
    const jar = [cookie({ name: "gone", value: "1", domain: "br.shein.com" })];
    const result = mergeSetCookie(jar, ["gone=; Path=/; Max-Age=0"], "br.shein.com", NOW_MS);
    expect(result.changed).toBe(true);
    expect(result.cookies).toHaveLength(0);
  });

  test("skips a malformed line instead of dropping the whole response", () => {
    const result = mergeSetCookie([], ["=nonsense", "ok=1; Path=/"], "br.shein.com", NOW_MS);
    expect(result.skipped).toBe(1);
    expect(result.cookies).toHaveLength(1);
  });
});

describe("memberIdFromJar", () => {
  test("reads the visible memberId cookie — the cheapest logged-in signal", () => {
    expect(memberIdFromJar([cookie({ name: "memberId", value: "4596239963" })])).toBe("4596239963");
  });

  test("is null without it (or when it is empty)", () => {
    expect(memberIdFromJar([])).toBeNull();
    expect(memberIdFromJar([cookie({ name: "memberId", value: "" })])).toBeNull();
  });
});

describe("inSiteDomain", () => {
  test("keeps every cookie of the registrable domain, subdomains included", () => {
    for (const domain of ["shein.com", ".shein.com", "br.shein.com", ".br.shein.com", "api-shein.shein.com"]) {
      expect(inSiteDomain(domain, "shein.com")).toBe(true);
    }
  });

  test("rejects a different registrable domain", () => {
    expect(inSiteDomain("shein.com.br", "shein.com")).toBe(false);
    expect(inSiteDomain("evilshein.com", "shein.com")).toBe(false);
  });

  test("is NOT hostMatches with the arguments swapped by accident", () => {
    // hostMatches asks "would this host send this cookie", which drops the
    // host-only cookies of a subdomain when filtering a whole jar.
    expect(hostMatches("shein.com", "br.shein.com")).toBe(false);
    expect(inSiteDomain("br.shein.com", "shein.com")).toBe(true);
  });
});
