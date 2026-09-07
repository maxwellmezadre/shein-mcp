import { describe, expect, test } from "bun:test";
import { orderStatusOf } from "../src/domain/status.js";

// The status enum is OPEN: the account that mapped the api only ever showed
// three of Shein's codes, so an unknown code keeps working from the signals
// around it and the raw code is always preserved.

describe("orderStatusOf", () => {
  test("maps the codes observed on a real account", () => {
    expect(orderStatusOf({ orderStatus: 3, pay_time: "0" }).status).toBe("unpaid");
    expect(orderStatusOf({ orderStatus: 5, pay_time: "1786732759" }).status).toBe("delivered");
    expect(orderStatusOf({ orderStatus: 10, pay_time: "1757707603" }).status).toBe("shipped");
  });

  test("always keeps the raw code and the site's own label", () => {
    const result = orderStatusOf({ orderStatus: 10, pay_time: "1", orderStatusTitle: "Enviado" });
    expect(result.code).toBe("10");
    expect(result.label).toBe("Enviado");
  });

  test("an unpaid order is unpaid whatever the code says", () => {
    // pay_time "0" is the only reliable "never paid" signal: isPaid is "0"
    // even on orders that were paid (observed on 21 real orders).
    expect(orderStatusOf({ orderStatus: 99, pay_time: "0" }).status).toBe("unpaid");
    expect(orderStatusOf({ orderStatus: 99, pay_time: "0", isPaid: "1" }).status).toBe("unpaid");
  });

  test("an unknown code falls back to what the shipment says", () => {
    const paid = { pay_time: "1786732759" };
    expect(orderStatusOf({ ...paid, orderStatus: 77 }).status).toBe("processing");
    expect(
      orderStatusOf({ ...paid, orderStatus: 77, order_package_info_list: [{ packageNo: "CBG1" }] }).status,
    ).toBe("shipped");
    expect(
      orderStatusOf({ ...paid, orderStatus: 77, order_package_info_list: [{ packageNo: "CBG1", signed_time: "1786732759" }] })
        .status,
    ).toBe("delivered");
  });

  test("no signal at all is unknown, not a guess", () => {
    expect(orderStatusOf({}).status).toBe("unknown");
    expect(orderStatusOf({}).code).toBeNull();
  });
});
