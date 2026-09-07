import { describe, expect, test } from "bun:test";
import { orderStatusOf } from "../src/domain/status.js";

// `now` is injected so "expired" is a fact in the test, not a clock race.
const NOW = 2_000_000_000;

// The status enum is OPEN: the account that mapped the api only ever showed
// three of Shein's codes, so an unknown code keeps working from the signals
// around it and the raw code is always preserved.

const PAST = 1_700_000_000;
const FUTURE = 4_100_000_000;
const signed = [{ packageNo: "CBG1", signed_time: "1786732759" }];
const inTransit = [{ packageNo: "CBG1" }];

describe("orderStatusOf", () => {
  test("maps what the site's own tabs say about a real account", () => {
    // Verified against the SSR tabs on 2026-09-07: with these 20 orders, the
    // site showed 0 in "Unpaid", 0 in "Shipped" and 9 in "Review".
    expect(orderStatusOf({ orderStatus: 3, pay_time: "0", order_expire_time: PAST }, NOW).status).toBe("cancelled");
    expect(orderStatusOf({ orderStatus: 5, pay_time: "1786732759", order_package_info_list: signed }, NOW).status).toBe("delivered");
    expect(orderStatusOf({ orderStatus: 10, pay_time: "1757707603", order_package_info_list: signed }, NOW).status).toBe("delivered");
  });

  test("an order still inside its payment window is unpaid, not cancelled", () => {
    expect(orderStatusOf({ orderStatus: 3, pay_time: "0", order_expire_time: FUTURE }, NOW).status).toBe("unpaid");
    // Without an expiry there is nothing to prove it lapsed: stay conservative.
    expect(orderStatusOf({ orderStatus: 3, pay_time: "0" }, NOW).status).toBe("unpaid");
  });

  test("a signed package means delivered whatever the code says", () => {
    expect(orderStatusOf({ orderStatus: 77, pay_time: "1", order_package_info_list: signed }, NOW).status).toBe("delivered");
  });

  test("a package still moving is shipped", () => {
    expect(orderStatusOf({ orderStatus: 77, pay_time: "1", order_package_info_list: inTransit }, NOW).status).toBe("shipped");
  });

  test("code 5 is delivered even when the carrier never signed", () => {
    // The site's tab for code 5 is "Review", which only happens after delivery.
    expect(orderStatusOf({ orderStatus: 5, pay_time: "1", order_package_info_list: inTransit }, NOW).status).toBe("delivered");
  });

  test("always keeps the raw code and the site's own label", () => {
    const result = orderStatusOf({ orderStatus: 10, pay_time: "1", orderStatusTitle: "Enviado" }, NOW);
    expect(result.code).toBe("10");
    expect(result.label).toBe("Enviado");
  });

  test("never paid beats any code, and isPaid is ignored", () => {
    // pay_time "0" is the only reliable "never paid" signal: isPaid is "0"
    // even on orders that were paid (observed on 21 real orders).
    expect(orderStatusOf({ orderStatus: 99, pay_time: "0" }, NOW).status).toBe("unpaid");
    expect(orderStatusOf({ orderStatus: 99, pay_time: "0", isPaid: "1" }, NOW).status).toBe("unpaid");
    expect(orderStatusOf({ orderStatus: 99, pay_time: "0", isPaid: "1", order_expire_time: PAST }, NOW).status).toBe("cancelled");
  });

  test("a paid order with no shipment yet is processing", () => {
    expect(orderStatusOf({ orderStatus: 77, pay_time: "1786732759" }, NOW).status).toBe("processing");
  });

  test("no signal at all is unknown, not a guess", () => {
    expect(orderStatusOf({}, NOW).status).toBe("unknown");
    expect(orderStatusOf({}, NOW).code).toBeNull();
  });
});
