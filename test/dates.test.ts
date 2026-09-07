import { describe, expect, test } from "bun:test";
import { isoFromUnix, unixOf } from "../src/domain/dates.js";

// Shein sends unix seconds, sometimes as a string, sometimes "0" for "never".
// Everything the tools return is ISO in Brasília time, so a date the user sees
// is the date they would see on the site.

describe("isoFromUnix", () => {
  test("renders Brasília time, not UTC", () => {
    // 1786732708 = 2026-08-14T18:38:28Z, which is 15:38 in Brasília.
    expect(isoFromUnix(1786732708)).toBe("2026-08-14T15:38:28-03:00");
    expect(isoFromUnix("1786732708")).toBe("2026-08-14T15:38:28-03:00");
  });

  test('"0", empty and missing all mean "never"', () => {
    expect(isoFromUnix("0")).toBeNull();
    expect(isoFromUnix(0)).toBeNull();
    expect(isoFromUnix("")).toBeNull();
    expect(isoFromUnix(undefined)).toBeNull();
    expect(isoFromUnix(null)).toBeNull();
  });

  test("ignores a value that is not a number", () => {
    expect(isoFromUnix("ontem")).toBeNull();
  });
});

describe("unixOf", () => {
  test("keeps the raw seconds for the cache, or null", () => {
    expect(unixOf("1786732708")).toBe(1786732708);
    expect(unixOf("0")).toBeNull();
    expect(unixOf(undefined)).toBeNull();
  });
});
