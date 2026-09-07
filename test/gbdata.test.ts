import { describe, expect, test } from "bun:test";
import { ParseError } from "../src/core/errors.js";
import { extractGbRawData, extractScriptObject, extractTrackSsrData } from "../src/shein/gbdata.js";

// The SSR pages carry their data as `var gbRawData = {...}` inside a <script>,
// followed by more JS. The extractor has to find the object by balancing
// braces while respecting strings, because the JSON is not on its own line
// and JSON.parse would choke on the trailing statements.

const page = (json: string, marker = "var gbRawData = ") =>
  `<html><head><script nonce="abc">gbCommonInfo.pageType='orders'\n  ${marker}${json};\n  window.x = {a:1};</script></head><body></body></html>`;

describe("extractScriptObject", () => {
  test("returns the object that follows the marker, ignoring the JS after it", () => {
    const html = page('{"order_list":[{"billno":"X"}],"sum":1}');
    expect(extractScriptObject(html, "var gbRawData = ")).toEqual({ order_list: [{ billno: "X" }], sum: 1 });
  });

  test("balances braces inside strings and escaped quotes", () => {
    const html = page('{"desc":"a } b \\" c {","nested":{"k":"}"},"arr":[{"x":"{"}]}');
    expect(extractScriptObject(html, "var gbRawData = ")).toEqual({
      desc: 'a } b " c {',
      nested: { k: "}" },
      arr: [{ x: "{" }],
    });
  });

  test("returns null when the marker is absent (login page, changed layout)", () => {
    expect(extractScriptObject("<html>no data</html>", "var gbRawData = ")).toBeNull();
  });

  test("reports unbalanced braces as a ParseError instead of a JSON stack trace", () => {
    expect(() => extractScriptObject('<script>var gbRawData = {"a":[1,2', "var gbRawData = ")).toThrow(ParseError);
  });

  test("takes the first occurrence and tolerates unicode and slashes in strings", () => {
    const html = page('{"goods_name":"Conjunto rendado reforçado","img":"//img.ltwebstatic.com/a.png","n":"R$69,98"}');
    expect(extractScriptObject(html, "var gbRawData = ")).toEqual({
      goods_name: "Conjunto rendado reforçado",
      img: "//img.ltwebstatic.com/a.png",
      n: "R$69,98",
    });
  });
});

describe("page-specific extractors", () => {
  test("extractGbRawData reads the orders/detail pages", () => {
    expect(extractGbRawData(page('{"orderInfo":{"billno":"X"}}'))).toEqual({ orderInfo: { billno: "X" } });
    expect(extractGbRawData("<html></html>")).toBeNull();
  });

  test("extractTrackSsrData reads the tracking page blob", () => {
    const html = page('{"isSsr":false,"billno":"X","trackInfo":{"carrier_name":"Imile"}}', "var gbOrdersTrackSsrData = ");
    expect(extractTrackSsrData(html)).toEqual({ isSsr: false, billno: "X", trackInfo: { carrier_name: "Imile" } });
  });
});
