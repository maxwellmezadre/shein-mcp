import { toDecimal } from "../domain/money.js";
import type { Item, Order, OrderSummary, Package, PriceLine } from "../domain/types.js";
import { compactObject } from "./define.js";

// The shape the tools answer with. Cents are an internal concern: a caller
// gets decimals plus the currency, which is what a model can read and add up.

export type PresentOptions = { compact?: boolean | undefined; includeAddress?: boolean | undefined };

type Headline = { total: number; discount: number; shipping: number };

/** The fields a list row and a full order have in common. */
function presentBase(summary: Omit<OrderSummary, "money">, money: Headline, opts: PresentOptions) {
  const base = {
    billno: summary.billno,
    placedAt: summary.placedAt,
    status: summary.status,
    total: toDecimal(money.total),
    currency: summary.currency,
    goodsCount: summary.goodsCount,
  };
  if (opts.compact) return base;
  return compactObject({
    ...base,
    checkoutId: summary.checkoutId,
    statusCode: summary.statusCode,
    statusLabel: summary.statusLabel ?? undefined,
    paidAt: summary.paidAt,
    discount: toDecimal(money.discount),
    shipping: toDecimal(money.shipping),
    packageCount: summary.packageCount,
    malls: summary.malls,
    returnable: summary.returnable,
    archived: summary.archived || undefined,
  });
}

export const presentSummary = (summary: OrderSummary, opts: PresentOptions = {}) =>
  presentBase(summary, summary.money, opts);

const presentItem = (item: Item, compact: boolean) =>
  compact
    ? { name: item.name, quantity: item.quantity, unitPrice: toDecimal(item.unitPrice) }
    : compactObject({
        id: item.id,
        goodsId: item.goodsId,
        name: item.name,
        attrs: item.attrs,
        quantity: item.quantity,
        unitPrice: toDecimal(item.unitPrice),
        totalPrice: toDecimal(item.totalPrice),
        retailUnitPrice: toDecimal(item.retailUnitPrice),
        store: item.store?.name ?? undefined,
        mall: item.mall ?? undefined,
        packageNo: item.packageNo ?? undefined,
        trackingNumber: item.trackingNumber ?? undefined,
        returnable: item.returnable,
        refundStatus: item.refundStatus ?? undefined,
        imageUrl: item.imageUrl ?? undefined,
        skuCode: item.skuCode ?? undefined,
      });

const presentLine = (line: PriceLine) => ({ type: line.type, label: line.label, amount: toDecimal(line.cents) });

export function presentPackage(parcel: Package) {
  return compactObject({
    packageNo: parcel.packageNo,
    trackingNumber: parcel.trackingNumber,
    carrier: parcel.carrier,
    trackUrl: parcel.trackUrl ?? undefined,
    events: parcel.events.map((event) =>
      compactObject({ at: event.at, description: event.description, place: event.place ?? undefined }),
    ),
  });
}

export function presentOrder(order: Order, opts: PresentOptions = {}) {
  const compact = opts.compact === true;
  return compactObject({
    // `saved` is the list row's `discount` under the name the detail uses.
    ...presentBase(order, { total: order.money.total, discount: order.money.saved, shipping: order.money.shipping }, opts),
    subtotal: toDecimal(order.money.subtotal),
    retail: compact ? undefined : toDecimal(order.money.retail),
    shippingOriginal: compact ? undefined : toDecimal(order.money.shippingOriginal),
    tax: toDecimal(order.money.tax),
    installmentFee: toDecimal(order.money.installmentFee),
    coupon: compact ? undefined : toDecimal(order.money.coupon),
    points: compact ? undefined : toDecimal(order.money.points),
    wallet: compact ? undefined : toDecimal(order.money.wallet),
    paymentMethod: order.payment.method,
    paymentTitle: order.payment.title ?? undefined,
    /** Always null: Shein's API does not carry the number of instalments. */
    installments: order.payment.installments,
    // Sums to `total`, which is the identity worth trusting (the named fields
    // above are Shein's own labels and do not form an equation).
    priceLines: compact ? undefined : order.priceLines.map(presentLine),
    items: order.items.map((item) => presentItem(item, compact)),
    ...(opts.includeAddress && order.address ? { address: order.address } : {}),
  });
}
