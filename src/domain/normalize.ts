import type {
  RawOrderDetail,
  RawOrderGoods,
  RawOrderListItem,
  RawTrackInfo,
  RawTrackSsrData,
} from "../shein/types.js";
import { isoFromUnix } from "./dates.js";
import { centsFromDecimal, priceCents } from "./money.js";
import { orderStatusOf } from "./status.js";
import type {
  Address,
  Item,
  Order,
  OrderMoney,
  OrderSummary,
  Package,
  PriceLine,
  TrackEvent,
} from "./types.js";

// The only file that knows Shein's field names. Everything above it works on
// the model in ./types.ts, so a rename on the site is a change here and
// nowhere else (docs/REDISCOVERY.md).

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
};

const int = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

/** `paymentTime` is milliseconds; `pay_time` and `addTime` are seconds. */
const isoFromMillis = (value: unknown): string | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return isoFromUnix(Math.trunc(parsed / 1000));
};

/**
 * An archived order answers `get_order_detail` with a shell: a billno and
 * nothing else. The list row is then the only source of truth.
 */
export const isEmptyDetail = (detail: RawOrderDetail): boolean =>
  !detail.orderGoodsList?.length && priceCents(detail.totalPrice) === 0;

function priceLinesOf(detail: RawOrderDetail): PriceLine[] {
  // Only the rows the site actually shows; together they equal the total
  // (verified on every order of the mapping account).
  return (detail.sorted_price ?? [])
    .filter((row) => String(row.show) === "1")
    .map((row) => ({
      type: str(row.type) ?? "unknown",
      label: (str(row.local_name) ?? "").replace(/:$/, ""),
      cents: centsFromDecimal(row.amount),
    }));
}

function moneyOf(detail: RawOrderDetail, summary: RawOrderListItem | undefined, lines: PriceLine[]): OrderMoney {
  const fallback = summary && isEmptyDetail(detail);
  if (fallback) {
    return {
      total: priceCents(summary.totalPrice),
      subtotal: priceCents(summary.totalPrice),
      retail: 0,
      saved: priceCents(summary.totalDiscountNew),
      shipping: priceCents(summary.shippingPrice),
      shippingOriginal: priceCents(summary.shippingPrice),
      tax: 0,
      installmentFee: 0,
      coupon: 0,
      points: 0,
      wallet: 0,
    };
  }
  return {
    total: priceCents(detail.totalPrice),
    subtotal: priceCents(detail.newSubTotalPrice ?? detail.subTotalPrice),
    retail: priceCents(detail.retailTotallPrice),
    saved: priceCents(detail.saved_total_price),
    shipping: priceCents(detail.shippingPrice),
    // What shipping would have cost before the free-shipping threshold.
    shippingOriginal: priceCents(detail.goods_origin_freight_fee ?? detail.originShippingPrice),
    // There is no tax field: the two `subTax` rows (import duty and ICMS) are it.
    tax: lines.filter((line) => line.type === "subTax").reduce((sum, line) => sum + line.cents, 0),
    installmentFee: priceCents(detail.installmentFee),
    coupon: priceCents(detail.couponPrice),
    points: priceCents(detail.pointPrice),
    wallet: priceCents(detail.usedWalletPrice),
  };
}

function itemOf(goods: RawOrderGoods, mall: string | null): Item {
  const product = goods.product ?? ({} as NonNullable<RawOrderGoods["product"]>);
  const rel = goods.goods_pkg_rel_list?.[0];
  const quantity = int(goods.quantity ?? goods.goods_count ?? 1) || 1;
  const unitPrice = priceCents(goods.unitPrice ?? goods.avgPrice);
  return {
    id: str(goods.id),
    goodsId: str(goods.goods_id ?? product.goods_id),
    goodsSn: str(goods.goods_sn ?? product.goods_sn ?? goods.display_goods_sn),
    skuCode: str(goods.sku_code ?? goods.display_sku_code),
    // The detail leaves `goods_name` empty and puts the title inside `product`.
    name: str(product.goods_name ?? goods.goods_name ?? goods.goodsNameWithBlindBox),
    attrs: str(goods.goods_attr ?? product.size),
    quantity,
    unitPrice,
    totalPrice: priceCents(goods.totalPrice) || unitPrice * quantity,
    retailUnitPrice: priceCents(goods.retail_price_vo ?? product.retailPrice),
    catId: str(goods.cat_id ?? product.cat_id),
    store: {
      code: str(goods.display_store_code ?? goods.store_code),
      name: str(goods.display_store_name ?? goods.store_name),
    },
    mall,
    statusCode: str(goods.status),
    packageNo: str(rel?.package_no ?? goods.reference_number),
    trackingNumber: str(rel?.shipping_no),
    returnable: str(goods.return_flag) === "1",
    refundStatus: str(goods.refund_type ?? goods.refund_scene),
    imageUrl: str(product.goods_img ?? goods.goods_img),
  };
}

function addressOf(detail: RawOrderDetail): Address | undefined {
  const raw = detail.shippingaddr_info as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const name = [str(raw.shipping_firstname), str(raw.shipping_lastname)].filter(Boolean).join(" ");
  return {
    name: name === "" ? null : name,
    line1: str(raw.shipping_address_1),
    line2: str(raw.shipping_address_2),
    district: str(raw.district ?? raw.shipping_district),
    city: str(raw.shipping_city),
    province: str(raw.shipping_province),
    postcode: str(raw.shipping_postcode),
    country: str(raw.shipping_country_name ?? raw.shipping_country_code),
    phone: str(raw.mask_shipping_telephone ?? raw.shipping_telephone),
  };
}

const mallsOf = (order: RawOrderListItem): string[] => [
  ...new Set((order.mall_list ?? []).map((mall) => str(mall.mall_name)).filter((name): name is string => name !== null)),
];

export type NormalizeOptions = {
  detail: RawOrderDetail;
  /** The list row, which carries `pay_time` and the total of an archived order. */
  summary?: RawOrderListItem | undefined;
  includeAddress?: boolean;
  archived?: boolean;
};

export function normalizeSummary(order: RawOrderListItem, opts: { archived?: boolean } = {}): OrderSummary {
  const status = orderStatusOf(order);
  return {
    billno: str(order.billno) ?? "",
    checkoutId: str(order.relationBillno ?? order.relation_billno),
    status: status.status,
    statusCode: status.code,
    statusLabel: status.label,
    placedAt: isoFromUnix(order.addTime),
    paidAt: isoFromUnix(order.pay_time),
    currency: str(order.currency_code) ?? "BRL",
    money: {
      total: priceCents(order.totalPrice),
      discount: priceCents(order.totalDiscountNew),
      shipping: priceCents(order.shippingPrice),
    },
    goodsCount: int(order.orderGoodsSum ?? order.quatity ?? order.orderGoodsList?.length ?? 0),
    packageCount: order.order_package_info_list?.length ?? 0,
    malls: mallsOf(order),
    returnable: str(order.isCanReturn) === "1",
    archived: opts.archived ?? false,
  };
}

export function normalizeOrder({ detail, summary, includeAddress, archived }: NormalizeOptions): Order {
  const empty = isEmptyDetail(detail);
  // Per key, the detail wins unless it is missing it: that is what makes an
  // archived order (an empty detail plus a full list row) come out whole.
  const merged: RawOrderListItem = { ...(summary ?? {}), ...pruned(detail) };
  const status = orderStatusOf(merged);
  const lines = priceLinesOf(detail);
  const malls = mallsOf(merged);
  const goods = (empty ? summary?.orderGoodsList : detail.orderGoodsList) ?? [];
  const address = includeAddress ? addressOf(detail) : undefined;

  return {
    billno: str(detail.billno ?? summary?.billno) ?? "",
    checkoutId: str(detail.relation_billno ?? summary?.relationBillno),
    status: status.status,
    statusCode: status.code,
    statusLabel: status.label,
    placedAt: isoFromUnix(merged.addTime),
    // `pay_time` (seconds) only exists on the list row; the detail has
    // `paymentTime` in milliseconds.
    paidAt: isoFromUnix(summary?.pay_time) ?? isoFromMillis(detail.paymentTime),
    currency: str(merged.currency_code) ?? "BRL",
    money: moneyOf(detail, summary, lines),
    priceLines: lines,
    payment: {
      method: str(merged.payment_method),
      title: str(detail.paymentTitle),
      type: str(merged.payment_type),
      installments: null,
    },
    items: goods.map((item) => itemOf(item, malls[0] ?? null)),
    goodsCount: int(merged.orderGoodsSum ?? merged.quatity ?? goods.length),
    packageCount: merged.order_package_info_list?.length ?? 0,
    malls,
    isMultiMall: merged.is_multi_mall === true || malls.length > 1,
    returnable: str(merged.isCanReturn) === "1",
    archived: archived ?? false,
    ...(address ? { address } : {}),
  };
}

/** Drops the nullish keys of the detail so they never clobber the list row. */
function pruned(detail: RawOrderDetail): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(detail).filter(([, value]) => value !== null && value !== undefined),
  );
}

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function eventOf(node: Record<string, unknown>): TrackEvent {
  return {
    at: isoFromUnix(node.timestamp as string | number | undefined),
    code: str(node.mall_status_code ?? node.detail_status),
    description: stripTags(String(node.details ?? "")),
    place: str(node.place),
  };
}

function packageOf(parcel: RawTrackInfo): Package {
  const events = (parcel.logistics_tracks_list ?? []).map((node) => eventOf(node as Record<string, unknown>));
  return {
    packageNo: str(parcel.package_no),
    trackingNumber: str(parcel.track_num),
    carrier: str(parcel.carrier_name),
    trackUrl: str(parcel.track_url),
    // Newest first, like the site shows it.
    events: events.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")),
  };
}

/**
 * `packageMap` (keyed "0", "1", …) is the source that is always there;
 * `trackInfo` is a copy of its first entry and disappears on orders that never
 * shipped. An empty entry means "no shipment", not a failure.
 */
export function normalizePackages(blob: RawTrackSsrData): Package[] {
  const map = (blob as { packageMap?: Record<string, RawTrackInfo> }).packageMap;
  const parcels = map ? Object.values(map) : [];
  const single = Array.isArray(blob.trackInfo) ? blob.trackInfo : blob.trackInfo ? [blob.trackInfo] : [];
  const source = parcels.length > 0 ? parcels : single;
  return source
    .filter((parcel) => parcel && (parcel.package_no || parcel.track_num || parcel.logistics_tracks_list?.length))
    .map(packageOf);
}
