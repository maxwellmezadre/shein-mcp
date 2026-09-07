// Raw payload shapes of Shein's internal bff-api and SSR blobs, as observed
// on the Brazilian site (task/PRD.md, "Descobertas"). The API is undocumented
// and unversioned: every field is optional and objects keep an index
// signature so unknown fields survive the raw_* round-trips in the cache.

/** `{code:"0", msg:"ok", info:{...}}`; any other `code` is an error. */
export type BffEnvelope<T = unknown> = {
  code: string;
  msg?: string;
  info: T | null;
  [key: string]: unknown;
};

/** Money as the site ships it: decimal strings plus the formatted label. */
export type RawPrice = {
  amount: string;
  amountWithSymbol?: string;
  usdAmount?: string;
  usdAmountWithSymbol?: string;
  priceShowStyle?: string;
  [key: string]: unknown;
};

export type RawPackageRel = {
  package_no?: string;
  shipping_no?: string;
  shipping_method_real?: string;
  [key: string]: unknown;
};

export type RawSkuAttr = { attr_name?: string; attr_value_name?: string; [key: string]: unknown };

/** A product line, as it appears in the list (`goods_name` present) and the detail (`product.*`). */
export type RawOrderGoods = {
  id?: string;
  goods_id?: number | string;
  goods_sn?: string;
  goods_name?: string;
  goodsNameWithBlindBox?: string;
  goods_attr?: string;
  goods_img?: string;
  quantity?: string | number;
  cat_id?: string;
  store_code?: string;
  store_name?: string;
  display_store_code?: string;
  display_store_name?: string;
  mall_code?: string;
  status?: string | number;
  sku_code?: string;
  sku_sale_attr?: RawSkuAttr[];
  unitPrice?: RawPrice;
  avgPrice?: RawPrice;
  totalPrice?: RawPrice;
  retail_price_vo?: RawPrice;
  special_price_vo?: RawPrice;
  return_flag?: string | number;
  refund_type?: unknown;
  refund_scene?: unknown;
  refund_record_status_list?: unknown;
  goods_pkg_rel_list?: RawPackageRel[];
  goods_sn_relation_goods_list?: Array<{ id?: string; status?: string; [key: string]: unknown }>;
  product?: {
    goods_id?: number | string;
    goods_sn?: string;
    goods_name?: string;
    goods_url_name?: string;
    goods_img?: string;
    cat_id?: string;
    size?: string;
    salePrice?: RawPrice;
    retailPrice?: RawPrice;
    order_goods_discount_percent?: string | number;
    productRelationID?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type RawPackageInfo = {
  packageNo?: string;
  status?: number | string | null;
  deliveryTime?: string | number | null;
  signed_time?: string | number | null;
  [key: string]: unknown;
};

export type RawMall = {
  mall_code?: string;
  mall_name?: string;
  store_code?: string;
  store_name?: string;
  transport_type?: string;
  [key: string]: unknown;
};

/** One order in `order_list` (list and archive; the archive shape is a subset). */
export type RawOrderListItem = {
  billno?: string;
  relationBillno?: string;
  addTime?: number | string;
  pay_time?: number | string;
  orderStatus?: number | string;
  status?: string | number;
  orderStatusTitle?: string | null;
  /** Formatted on the list ("R$69,98"), an object on the detail. */
  totalPrice?: string | RawPrice;
  totalDiscountNew?: RawPrice;
  shippingPrice?: RawPrice;
  currency_code?: string;
  payment_method?: string;
  payment_type?: number | string;
  isCanReturn?: string | number;
  /** When an unpaid order stops being payable; past it, the site drops it. */
  order_expire_time?: number | string;
  is_multi_mall?: boolean;
  mall_list?: RawMall[];
  orderGoodsList?: RawOrderGoods[];
  orderGoodsSum?: number | string;
  quatity?: number | string;
  order_package_info_list?: RawPackageInfo[];
  track_h5_link?: string;
  shippingaddr_info?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RawOrderListPage = {
  order_list?: RawOrderListItem[];
  sum?: number | string;
  orderStatusList?: Array<{ id?: number; orderStatus?: string; type?: string; [key: string]: unknown }>;
  sum_filed_orders?: number | string;
  [key: string]: unknown;
};

export type RawSortedPrice = {
  type?: string;
  local_name?: string;
  amount?: string;
  price_with_symbol?: string;
  show?: string | number;
  [key: string]: unknown;
};

export type RawSubOrderStatus = {
  packageState?: string;
  package_title?: string;
  firstPackageNo?: string;
  return_history_link?: string | null;
  refund_record_url_link?: string | null;
  order_trace_id?: string;
  goodsList?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/** `info` of get_order_detail (378 keys observed; only the ones we read are typed). */
export type RawOrderDetail = RawOrderListItem & {
  relation_billno?: string;
  totalPrice?: RawPrice;
  subTotalPrice?: RawPrice;
  newSubTotalPrice?: RawPrice;
  retailTotallPrice?: RawPrice;
  saved_total_price?: RawPrice;
  originShippingPrice?: RawPrice;
  /** What shipping would have cost before the free-shipping threshold. */
  goods_origin_freight_fee?: RawPrice;
  goods_actual_freight_fee?: RawPrice;
  freight_price?: RawPrice;
  couponPrice?: RawPrice;
  pointPrice?: RawPrice;
  usedWalletPrice?: RawPrice;
  installmentFee?: RawPrice;
  handling_fee?: RawPrice;
  taxPrice?: RawPrice;
  extraTaxInfo?: { taxPriceAmount?: RawPrice; [key: string]: unknown } | null;
  usaPrice?: RawPrice;
  paymentTitle?: string | null;
  paymentTime?: string | number | null;
  sorted_price?: RawSortedPrice[];
  subOrderStatus?: RawSubOrderStatus[];
  [key: string]: unknown;
};

export type RawTrackNode = {
  date?: string;
  time?: string;
  timestamp?: string | number;
  status?: string;
  secondary_status?: string;
  mall_status_code?: string;
  detail_status?: string;
  details?: string;
  place?: string;
  channel?: string;
  [key: string]: unknown;
};

export type RawTrackInfo = {
  billno?: string;
  carrier_name?: string;
  track_num?: string;
  track_url?: string;
  package_no?: string;
  box_no?: string;
  logistics_tracks_list?: RawTrackNode[];
  [key: string]: unknown;
};

/** `gbOrdersTrackSsrData`; whether `trackInfo` is one object or a list per package is confirmed by the captures. */
export type RawTrackSsrData = {
  billno?: string;
  trackInfo?: RawTrackInfo | RawTrackInfo[] | null;
  [key: string]: unknown;
};
