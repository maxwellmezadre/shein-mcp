import type { RawOrderListItem } from "../shein/types.js";
import { unixOf } from "./dates.js";

// Shein's `orderStatus` is a number with no public meaning, and the labels it
// ships are the LAST thing that happened, not the current state ("Enviado" on
// an order delivered weeks ago). So the reading is driven by signals — was it
// paid, did the payment window lapse, was the parcel signed — and the raw code
// travels along untouched.
//
// Checked against the site's own tabs on 2026-09-07: for the 20 orders of the
// mapping account, Shein showed 0 in "Unpaid", 0 in "Shipped" and 9 in
// "Review". Reading code 3 as "unpaid" or code 10 as "shipped" would have
// contradicted the site on 11 of them.

export const ORDER_STATUSES = [
  "unpaid",
  "processing",
  "shipped",
  "delivered",
  "returned",
  "cancelled",
  "unknown",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The one code that is a state and not a milestone: Shein files it under the
 * "Review" tab, which an order only reaches after being delivered.
 */
const DELIVERED_CODES = new Set(["5"]);

export type StatusResult = {
  status: OrderStatus;
  /** Shein's own numeric code, never dropped. */
  code: string | null;
  /** The site's own label when it sends one ("Enviado"). */
  label: string | null;
};

export function orderStatusOf(order: RawOrderListItem, nowSeconds = Math.floor(Date.now() / 1000)): StatusResult {
  const code = order.orderStatus === undefined || order.orderStatus === null ? null : String(order.orderStatus);
  const label = order.orderStatusTitle ?? null;
  const packages = order.order_package_info_list ?? [];
  const result = (status: OrderStatus): StatusResult => ({ status, code, label });

  // `isPaid` is "0" even on paid orders, so `pay_time` is the only reliable
  // "never paid" signal. A pay_time that is ABSENT says nothing; one that is
  // "0" says "never paid".
  const hasPayTime = order.pay_time !== undefined && order.pay_time !== null && order.pay_time !== "";
  if (hasPayTime && unixOf(order.pay_time) === null) {
    // Never paid AND the payment window lapsed: the site drops it from the
    // "Unpaid" tab, so calling it unpaid would be reporting a bill that is not
    // owed. Without an expiry there is nothing to prove it lapsed.
    const expiresAt = unixOf(order.order_expire_time);
    return result(expiresAt !== null && expiresAt < nowSeconds ? "cancelled" : "unpaid");
  }

  if (packages.some((info) => unixOf(info.signed_time) !== null)) return result("delivered");
  if (code !== null && DELIVERED_CODES.has(code)) return result("delivered");
  if (packages.length > 0) return result("shipped");
  if (!hasPayTime && code === null) return result("unknown");
  return result("processing");
}
