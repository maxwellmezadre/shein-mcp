import type { OrderStatus } from "./status.js";

// The model the tools answer with. Money is integer cents; dates are ISO in
// Brasília time; every raw Shein code is carried alongside its reading, so a
// status this project has never seen is still reported honestly.

export type PriceLine = {
  /** Shein's own row type: `newSubTotal`, `shipping`, `subTax`, `commission`… */
  type: string;
  /** The label the site prints next to it, in the account's language. */
  label: string;
  cents: number;
};

/**
 * The amounts the site itself names. They are NOT an equation: on an
 * international order `subtotal` and the `newSubTotal` row disagree. The
 * breakdown that adds up to `total` is `priceLines`.
 */
export type OrderMoney = {
  total: number;
  subtotal: number;
  /** Before any discount. */
  retail: number;
  /** What the site says was saved, shipping included. */
  saved: number;
  shipping: number;
  shippingOriginal: number;
  /** Sum of the `subTax` rows; there is no single tax field. */
  tax: number;
  installmentFee: number;
  coupon: number;
  points: number;
  wallet: number;
};

/** What the list row carries: no breakdown, and the total only as a label. */
export type SummaryMoney = { total: number; discount: number; shipping: number };

export type Store = { code: string | null; name: string | null };

export type Item = {
  /** Shein's line id, the same one the tracking page calls `order_goods_id`. */
  id: string | null;
  goodsId: string | null;
  goodsSn: string | null;
  skuCode: string | null;
  name: string | null;
  /** Colour and size as one label ("Vinho / GG"). */
  attrs: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  retailUnitPrice: number;
  catId: string | null;
  store: Store | null;
  mall: string | null;
  statusCode: string | null;
  packageNo: string | null;
  trackingNumber: string | null;
  returnable: boolean;
  /** Set only while a refund exists for the line. */
  refundStatus: string | null;
  imageUrl: string | null;
};

export type TrackEvent = {
  at: string | null;
  /** The carrier's own status code for the step. */
  code: string | null;
  description: string;
  place: string | null;
};

export type Package = {
  packageNo: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  trackUrl: string | null;
  events: TrackEvent[];
};

export type Address = {
  name: string | null;
  line1: string | null;
  line2: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  postcode: string | null;
  country: string | null;
  phone: string | null;
};

export type Payment = {
  method: string | null;
  title: string | null;
  type: string | null;
  /**
   * Always null: the number of instalments does not exist anywhere in this
   * API (`PayDivide` is always zero and hidden). Only `installmentFee` does.
   */
  installments: null;
};

export type OrderSummary = {
  billno: string;
  /** Groups the orders of one checkout; several may share a package. */
  checkoutId: string | null;
  status: OrderStatus;
  statusCode: string | null;
  statusLabel: string | null;
  placedAt: string | null;
  paidAt: string | null;
  currency: string;
  money: SummaryMoney;
  goodsCount: number;
  packageCount: number;
  malls: string[];
  returnable: boolean;
  archived: boolean;
};

export type Order = Omit<OrderSummary, "money"> & {
  money: OrderMoney;
  priceLines: PriceLine[];
  payment: Payment;
  items: Item[];
  isMultiMall: boolean;
  /** Only when the caller asked for it: this is the buyer's home address. */
  address?: Address;
};
