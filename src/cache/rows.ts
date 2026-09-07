import type { Item, Order, OrderSummary, Package, PriceLine, TrackEvent } from "../domain/types.js";
import type { OrderStatus } from "../domain/status.js";

// The storage shape and the mapping back to the domain model. Rows are flat and
// money is integer cents so `SUM()` is exact; the model is rebuilt on read, so
// a better parser can be re-run over `raw_detail` without another crawl.

export type OrderRow = {
  billno: string;
  checkout_id: string | null;
  status: string;
  status_code: string | null;
  status_label: string | null;
  placed_at: string | null;
  placed_day: string | null;
  paid_at: string | null;
  currency: string;
  total_cents: number;
  subtotal_cents: number;
  retail_cents: number;
  saved_cents: number;
  shipping_cents: number;
  shipping_original_cents: number;
  tax_cents: number;
  installment_fee_cents: number;
  coupon_cents: number;
  points_cents: number;
  wallet_cents: number;
  payment_method: string | null;
  payment_title: string | null;
  goods_count: number;
  package_count: number;
  malls: string | null;
  is_multi_mall: number;
  returnable: number;
  archived: number;
  raw_list: string | null;
  raw_detail: string | null;
  detail_fetched_at: string | null;
  detail_error: string | null;
  parser_version: number | null;
  updated_at: string;
};

export type ItemRow = {
  id: string;
  billno: string;
  position: number;
  goods_id: string | null;
  goods_sn: string | null;
  sku_code: string | null;
  name: string | null;
  attrs: string | null;
  quantity: number;
  unit_cents: number;
  total_cents: number;
  retail_unit_cents: number;
  cat_id: string | null;
  store_code: string | null;
  store_name: string | null;
  mall: string | null;
  status_code: string | null;
  package_no: string | null;
  tracking_number: string | null;
  returnable: number;
  refund_status: string | null;
  image_url: string | null;
};

export type PriceLineRow = { billno: string; position: number; type: string; label: string; cents: number };

export type PackageRow = {
  billno: string;
  package_no: string;
  tracking_number: string | null;
  carrier: string | null;
  track_url: string | null;
  event_count: number;
  last_event_at: string | null;
  payload_json: string;
  tracked_at: string;
};

const bool = (value: boolean): number => (value ? 1 : 0);
/** The Brasília day, which is what a date filter compares against. */
const dayOf = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/** The columns a list row can fill; the detail fills the rest. */
export function summaryRow(summary: OrderSummary, rawList: string | null, updatedAt: string): Partial<OrderRow> {
  return {
    billno: summary.billno,
    checkout_id: summary.checkoutId,
    status: summary.status,
    status_code: summary.statusCode,
    status_label: summary.statusLabel,
    placed_at: summary.placedAt,
    placed_day: dayOf(summary.placedAt),
    paid_at: summary.paidAt,
    currency: summary.currency,
    total_cents: summary.money.total,
    shipping_cents: summary.money.shipping,
    saved_cents: summary.money.discount,
    goods_count: summary.goodsCount,
    package_count: summary.packageCount,
    malls: JSON.stringify(summary.malls),
    returnable: bool(summary.returnable),
    archived: bool(summary.archived),
    raw_list: rawList,
    updated_at: updatedAt,
  };
}

export function orderRow(
  order: Order,
  rawDetail: string | null,
  parserVersion: number,
  updatedAt: string,
): Partial<OrderRow> {
  return {
    billno: order.billno,
    checkout_id: order.checkoutId,
    status: order.status,
    status_code: order.statusCode,
    status_label: order.statusLabel,
    placed_at: order.placedAt,
    placed_day: dayOf(order.placedAt),
    paid_at: order.paidAt,
    currency: order.currency,
    total_cents: order.money.total,
    subtotal_cents: order.money.subtotal,
    retail_cents: order.money.retail,
    saved_cents: order.money.saved,
    shipping_cents: order.money.shipping,
    shipping_original_cents: order.money.shippingOriginal,
    tax_cents: order.money.tax,
    installment_fee_cents: order.money.installmentFee,
    coupon_cents: order.money.coupon,
    points_cents: order.money.points,
    wallet_cents: order.money.wallet,
    payment_method: order.payment.method,
    payment_title: order.payment.title,
    goods_count: order.goodsCount,
    package_count: order.packageCount,
    malls: JSON.stringify(order.malls),
    is_multi_mall: bool(order.isMultiMall),
    returnable: bool(order.returnable),
    archived: bool(order.archived),
    raw_detail: rawDetail,
    detail_fetched_at: updatedAt,
    detail_error: null,
    parser_version: parserVersion,
    updated_at: updatedAt,
  };
}

export function itemRows(order: Order): ItemRow[] {
  return order.items.map((item, position) => ({
    // Shein always sends a line id; the fallback only guards a shape we have
    // not seen, and still has to be unique per order.
    id: item.id ?? `${order.billno}:${item.goodsId ?? position}:${position}`,
    billno: order.billno,
    position,
    goods_id: item.goodsId,
    goods_sn: item.goodsSn,
    sku_code: item.skuCode,
    name: item.name,
    attrs: item.attrs,
    quantity: item.quantity,
    unit_cents: item.unitPrice,
    total_cents: item.totalPrice,
    retail_unit_cents: item.retailUnitPrice,
    cat_id: item.catId,
    store_code: item.store?.code ?? null,
    store_name: item.store?.name ?? null,
    mall: item.mall,
    status_code: item.statusCode,
    package_no: item.packageNo,
    tracking_number: item.trackingNumber,
    returnable: bool(item.returnable),
    refund_status: item.refundStatus,
    image_url: item.imageUrl,
  }));
}

export const priceLineRows = (order: Order): PriceLineRow[] =>
  order.priceLines.map((line, position) => ({ billno: order.billno, position, ...line }));

export function packageRows(billno: string, packages: Package[], trackedAt: string): PackageRow[] {
  return packages.map((parcel, index) => ({
    billno,
    package_no: parcel.packageNo ?? parcel.trackingNumber ?? String(index),
    tracking_number: parcel.trackingNumber,
    carrier: parcel.carrier,
    track_url: parcel.trackUrl,
    event_count: parcel.events.length,
    last_event_at: parcel.events[0]?.at ?? null,
    payload_json: JSON.stringify(parcel.events),
    tracked_at: trackedAt,
  }));
}

export const itemOf = (row: ItemRow): Item => ({
  id: row.id,
  goodsId: row.goods_id,
  goodsSn: row.goods_sn,
  skuCode: row.sku_code,
  name: row.name,
  attrs: row.attrs,
  quantity: row.quantity,
  unitPrice: row.unit_cents,
  totalPrice: row.total_cents,
  retailUnitPrice: row.retail_unit_cents,
  catId: row.cat_id,
  store: { code: row.store_code, name: row.store_name },
  mall: row.mall,
  statusCode: row.status_code,
  packageNo: row.package_no,
  trackingNumber: row.tracking_number,
  returnable: row.returnable === 1,
  refundStatus: row.refund_status,
  imageUrl: row.image_url,
});

export const priceLineOf = (row: PriceLineRow): PriceLine => ({
  type: row.type,
  label: row.label,
  cents: row.cents,
});

export const packageOf = (row: PackageRow): Package => ({
  packageNo: row.package_no,
  trackingNumber: row.tracking_number,
  carrier: row.carrier,
  trackUrl: row.track_url,
  events: JSON.parse(row.payload_json) as TrackEvent[],
});

export function summaryOf(row: OrderRow): OrderSummary {
  return {
    billno: row.billno,
    checkoutId: row.checkout_id,
    status: row.status as OrderStatus,
    statusCode: row.status_code,
    statusLabel: row.status_label,
    placedAt: row.placed_at,
    paidAt: row.paid_at,
    currency: row.currency,
    money: { total: row.total_cents, discount: row.saved_cents, shipping: row.shipping_cents },
    goodsCount: row.goods_count,
    packageCount: row.package_count,
    malls: row.malls ? (JSON.parse(row.malls) as string[]) : [],
    returnable: row.returnable === 1,
    archived: row.archived === 1,
  };
}

export function orderOf(row: OrderRow, items: ItemRow[], lines: PriceLineRow[]): Order {
  return {
    ...summaryOf(row),
    money: {
      total: row.total_cents,
      subtotal: row.subtotal_cents,
      retail: row.retail_cents,
      saved: row.saved_cents,
      shipping: row.shipping_cents,
      shippingOriginal: row.shipping_original_cents,
      tax: row.tax_cents,
      installmentFee: row.installment_fee_cents,
      coupon: row.coupon_cents,
      points: row.points_cents,
      wallet: row.wallet_cents,
    },
    priceLines: lines.map(priceLineOf),
    payment: {
      method: row.payment_method,
      title: row.payment_title,
      type: null,
      installments: null,
    },
    items: items.map(itemOf),
    isMultiMall: row.is_multi_mall === 1,
  };
}
