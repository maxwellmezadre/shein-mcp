import type { RawOrderListItem } from "../shein/types.js";
import { unixOf } from "./dates.js";

// Shein's `orderStatus` is a number with no public meaning. The account that
// mapped the API only ever showed three of them, so this enum is OPEN: known
// codes win, an unknown one is read from the signals around it, and the raw
// code is always carried through so nothing is lost.

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

/** Codes seen on a real account (2026-09-07, 21 orders). */
const BY_CODE: Record<string, OrderStatus> = {
  "3": "unpaid",
  "5": "delivered",
  "10": "shipped",
};

export type StatusResult = {
  status: OrderStatus;
  /** Shein's own numeric code, never dropped. */
  code: string | null;
  /** The site's own label when it sends one ("Enviado"). */
  label: string | null;
};

export function orderStatusOf(order: RawOrderListItem): StatusResult {
  const code = order.orderStatus === undefined || order.orderStatus === null ? null : String(order.orderStatus);
  const label = order.orderStatusTitle ?? null;
  const packages = order.order_package_info_list ?? [];

  // `isPaid` is "0" even on paid orders, so `pay_time` is the only reliable
  // "never paid" signal (observed on every order of the mapping account).
  // A pay_time that is ABSENT says nothing; one that is "0" says "never paid".
  const hasPayTime = order.pay_time !== undefined && order.pay_time !== null && order.pay_time !== "";
  if (hasPayTime && unixOf(order.pay_time) === null) return { status: "unpaid", code, label };

  const known = code === null ? undefined : BY_CODE[code];
  if (known) return { status: known, code, label };

  if (packages.some((info) => unixOf(info.signed_time) !== null)) return { status: "delivered", code, label };
  if (packages.length > 0) return { status: "shipped", code, label };
  return { status: code === null ? "unknown" : "processing", code, label };
}
