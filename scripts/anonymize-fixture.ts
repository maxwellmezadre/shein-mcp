#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractTrackSsrData } from "../src/shein/gbdata.js";

// Turns the raw captures in task/captures/ into the fixtures committed under
// test/fixtures/. The repository is public, so this is the only path by which
// real account data may become a test.
//
// Design rules:
//  - DETERMINISTIC (salted hash): the same id always maps to the same fake id,
//    so the joins survive — the `billno` of a detail is still one of the list's,
//    and the package of an order is still the one the tracking page shows.
//  - MONEY, QUANTITIES AND DATES ARE NEVER TOUCHED. Ids are remapped by FIELD
//    NAME plus a few unmistakable patterns, never by "any long digit run":
//    a unix timestamp is 10 digits and remapping it would destroy every date.
//  - LEAK GUARD: the script fails if any value it replaced survives anywhere.

const ROOT = join(import.meta.dir, "..");
const CAPTURES = join(ROOT, "task", "captures");
const OUT = join(ROOT, "test", "fixtures");
const SALT_FILE = join(ROOT, "task", "anonymize.salt");
const SECRETS_FILE = join(ROOT, "task", "anonymize.secrets");

/**
 * Any field whose NAME looks like personal data, whatever the payload calls
 * it. The shipping address, the billing address and the tracking page each
 * name the same things differently (`shipping_address_1`, `address_1`,
 * `shipping_address1`), so matching by keyword is what makes an unseen field
 * safe by construction; the leak guard is the proof.
 */
const PII_KEY =
  /(phone|telephone|^tel$|address|city$|province|district|street|postcode|zip|tax_number|nationalid|national_id|passport|birthday|email|cpf|_sex$|^sex$|^place$|firstname|lastname|first_name|last_name|father_name|middle_name|english_name|contact_information|receiver)/i;

/** Fields the keyword rule would hit but that carry no personal data. */
const NOT_PII = new Set(["addressSyncInfo", "isOrderShippingAddressEditable", "enable_check_multi_edit"]);

/** What each kind of personal field becomes; the default is a generic mask. */
function placeholderFor(key: string): string {
  const name = key.toLowerCase();
  if (/postcode|zip/.test(name)) return "00000-000";
  if (/tax_number|cpf/.test(name)) return "000.000.000-00";
  if (/email/.test(name)) return "comprador@exemplo.test";
  if (/phone|telephone|^tel$/.test(name)) return "11999999999";
  if (/city|place/.test(name)) return "Cidade Exemplo";
  if (/province/.test(name)) return "Estado Exemplo";
  if (/district/.test(name)) return "Bairro Exemplo";
  if (/street|address/.test(name)) return "Rua Exemplo, 123";
  if (/firstname|first_name/.test(name)) return "Comprador Exemplo";
  return "";
}

/** Field names whose STRING value is replaced wholesale: pure PII. */
const REPLACEMENTS: Record<string, string> = {
  shipping_firstname: "Comprador Exemplo",
  shipping_lastname: "",
  shipping_father_name: "",
  shipping_middle_name: "",
  shipping_english_name: "",
  shipping_telephone: "11999999999",
  mask_shipping_telephone: "11****9999",
  shipping_telephone_standby_cipher: "",
  backupTelephone: "",
  telephone: "",
  shipping_address_1: "Rua Exemplo, 123",
  shipping_address_2: "Complemento Exemplo",
  shipping_street: "Rua Exemplo",
  street: "123",
  district: "Bairro Exemplo",
  shipping_district: "Bairro Exemplo",
  shipping_city: "Cidade Exemplo",
  shipping_province: "Estado Exemplo",
  shipping_postcode: "00000-000",
  short_address: "Rua Exemplo, 123",
  tax_number: "000.000.000-00",
  nationalId: "",
  birthday: "",
  company: "",
  email: "comprador@exemplo.test",
  contact_information: "(55)1100000000",
};

/** Field names carrying an id: remapped, keeping the prefix and the length. */
const ID_FIELDS = new Set([
  "billno", "relationBillno", "relation_billno", "sub_billno", "merge_buy_billno", "allBillNos",
  "packageNo", "package_no", "firstPackageNo", "box_no", "lading_no", "shipping_no", "track_num",
  "reference_number", "referenceNumberList", "order_goods_id", "order_id", "order_trace_id",
  "goods_sn", "display_goods_sn", "sku_code", "display_sku_code", "productRelationID", "spu",
  "store_code", "display_store_code", "storeCodeList", "memberId", "member_id", "sharepayMemberId",
  "ocb_payment_no", "confluence_batch_no", "id", "address_id", "jump_pci_token", "token_id",
]);

/**
 * Free text written by a human: product titles, store names and the courier's
 * own notes (which carry the delivery city). Rewritten word by word, so the
 * shape survives and the content does not. Public labels the tests read
 * (`mall_name`, `local_name`, `package_title`, `carrier_name`) are NOT here.
 */
const TEXT_FIELDS = new Set([
  "goods_name", "goodsNameWithBlindBox", "goods_url_name", "store_name", "display_store_name",
  "store_nick_name", "details", "desc", "remark_user",
]);

/**
 * Bulky boilerplate no test reads: translation dictionaries, A/B config,
 * marketing blocks. Dropping them keeps the fixtures readable and small.
 */
const DROPPED = new Set([
  "language", "languageText", "trackLang", "locals", "localDateData", "dateLangMap",
  "abtInfo", "abtInfos", "listAbtResult", "app_burying_point", "_registeredComponents",
  "bsLibsEnvs", "PUBLIC_CDN", "cccNotice", "trackBffBannerNew", "trackNoticeMap",
  "paymentMethodLimitInfo", "paymentMethodAmountLimitInfo", "recallBanner", "topNotice",
  "newUserTps", "pointActivityInfo", "multiCouponActivityInfo", "centerActivityInfo",
  "activityInfo", "reviewPromptTip", "size_rule_list", "new_pay_success", "guarantee_banner_info",
  "shippingEffectInfo", "transport_time_list", "transport_time_detail_list", "styles",
]);

/** Order/package numbers appear inside URLs and HTML too, not just in fields. */
const CODE_PATTERN = /\b(?:GSH|USH|CBG|W20|SHR)[A-Z0-9]{8,20}\b/g;
/** 11+ digits is a tracking number; a unix timestamp in SECONDS is 10 and must survive. */
const LONG_DIGITS = /(?<!\d)\d{11,}(?!\d)/g;

/**
 * …but a timestamp in MILLISECONDS is 13 digits, exactly like a tracking
 * number. Fields that hold a time are never remapped, or every date in the
 * fixtures becomes fiction (`paymentTime` was the one that caught this).
 */
const TIME_KEY = /(time|date|timestamp|expire|_at$)/i;
const NUMERIC_ONLY = /^[\d.\-]+$/;

const WORDS = [
  "Alfa", "Bravo", "Cabo", "Delta", "Eco", "Fenix", "Gama", "Hidra", "Indigo", "Jade",
  "Kilo", "Lima", "Micro", "Nano", "Omega", "Pixel", "Quartzo", "Rubi", "Sigma", "Tango",
  "Ultra", "Vega", "Watt", "Xenon", "Yuca", "Zeta", "Neo", "Prisma", "Orbita", "Vetor",
];

function loadSalt(): string {
  if (existsSync(SALT_FILE)) return readFileSync(SALT_FILE, "utf8").trim();
  const salt = randomBytes(16).toString("hex");
  mkdirSync(join(ROOT, "task"), { recursive: true, mode: 0o700 });
  writeFileSync(SALT_FILE, `${salt}\n`, { mode: 0o600 });
  return salt;
}

const salt = loadSalt();
const digest = (value: string): string => createHash("sha256").update(`${salt}${value}`).digest("hex");
/** Extra strings the user knows are private (name, e-mail…), one per line. */
const extraSecrets = existsSync(SECRETS_FILE)
  ? readFileSync(SECRETS_FILE, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  : [];

/** Every original value that was replaced; the leak guard hunts for all of them. */
const secrets = new Set<string>(extraSecrets);
/** Which field a secret came from — a leak has to name the culprit to be fixable. */
const secretOrigin = new Map<string, string>();
/** original → what it must become, applied to the WHOLE output at the end. */
const globalMap = new Map<string, string>();
const remember = (value: string, key: string, replacement: string): void => {
  secrets.add(value);
  if (!secretOrigin.has(value)) secretOrigin.set(value, key);
  // An id remapped in `goods_sn` also shows up in `skc` and `fromSkuCode`;
  // a name replaced in the shipping address also shows up in free text. One
  // global pass at the end is what makes "replaced somewhere" mean
  // "replaced everywhere".
  if (value.length >= 6 && !globalMap.has(value)) globalMap.set(value, replacement);
};
const idCache = new Map<string, string>();
const wordCache = new Map<string, string>();

/** Keeps the shape of an id: same length, same leading letters, fake digits. */
function fakeId(value: string): string {
  const cached = idCache.get(value);
  if (cached) return cached;
  const prefix = value.match(/^[A-Za-z]*/)?.[0] ?? "";
  const digits = digest(value).replace(/\D/g, "").padEnd(value.length, "7");
  const mapped = prefix + digits.slice(0, Math.max(0, value.length - prefix.length));
  idCache.set(value, mapped);
  if (value.length >= 4) remember(value, "id", mapped);
  return mapped;
}

function fakeWord(word: string): string {
  const key = word.toLowerCase();
  let mapped = wordCache.get(key);
  if (!mapped) {
    mapped = WORDS[Number.parseInt(digest(key).slice(0, 8), 16) % WORDS.length] as string;
    wordCache.set(key, mapped);
  }
  if (word === word.toUpperCase()) return mapped.toUpperCase();
  if (word === word.toLowerCase()) return mapped.toLowerCase();
  return mapped;
}

/** Rewrites free text word by word; punctuation, digits and markup survive. */
const fakeText = (text: string): string =>
  scrub(text).replace(/[\p{L}]{3,}/gu, (word) => fakeWord(word));

/** Ids that travel inside URLs, HTML and other free text. */
function scrub(text: string): string {
  return text.replace(CODE_PATTERN, (match) => fakeId(match)).replace(LONG_DIGITS, (match) => fakeId(match));
}

type Json = unknown;

function walk(node: Json, key = ""): Json {
  if (Array.isArray(node)) return node.map((item) => walk(item, key));
  if (node !== null && typeof node === "object") {
    const out: Record<string, Json> = {};
    for (const [childKey, value] of Object.entries(node as Record<string, Json>)) {
      if (DROPPED.has(childKey)) continue;
      // Keys carry ids too (packageMap is keyed by package number).
      out[scrub(childKey)] = walk(value, childKey);
    }
    return out;
  }
  if (typeof node === "string") {
    if (node === "") return node;
    if (TIME_KEY.test(key) && NUMERIC_ONLY.test(node)) return node;
    if (ID_FIELDS.has(key)) return fakeId(node);
    if (key in REPLACEMENTS) {
      if (node.trim() !== "") remember(node, key, REPLACEMENTS[key] as string);
      return REPLACEMENTS[key] as string;
    }
    if (TEXT_FIELDS.has(key)) {
      const text = fakeText(node);
      remember(node, key, text);
      return text;
    }
    if (PII_KEY.test(key) && !NOT_PII.has(key)) {
      const placeholder = placeholderFor(key);
      remember(node, key, placeholder);
      return placeholder;
    }
    return scrub(node);
  }
  if (typeof node === "number" && ID_FIELDS.has(key) && Math.abs(node) > 9_999) {
    return Number(fakeId(String(node)));
  }
  return node;
}

/** Which captures become fixtures, and under which name. */
type Spec = { source: string; out: string; pick?: (payload: any) => unknown };

const KEEP_ORDERS = 3;

function main(): void {
  if (!existsSync(CAPTURES)) {
    console.error(`Sem capturas em ${CAPTURES}. Rode antes: bun run scripts/capture-fixtures.ts --write`);
    process.exit(1);
  }
  const write = process.argv.includes("--write");
  const detailOf = (billno: string) => `detail-${billno.slice(-6)}.json`;
  const list = JSON.parse(readFileSync(join(CAPTURES, "list-p1.json"), "utf8")) as any;
  const orders = list.info.order_list as any[];
  // A national order with instalment fee, an international one with tax, and
  // the archived one: the three shapes the parsers have to survive.
  const taxed = orders.find((o) => {
    const file = join(CAPTURES, detailOf(o.billno));
    return existsSync(file) && readFileSync(file, "utf8").includes("subTax");
  });
  const archived = (JSON.parse(readFileSync(join(CAPTURES, "archive-p1.json"), "utf8")) as any).info.order_list[0];

  const specs: Spec[] = [
    { source: "list-p1.json", out: "order-list.json", pick: (p) => ({ ...p, info: { ...p.info, order_list: p.info.order_list.slice(0, KEEP_ORDERS) } }) },
    { source: "archive-p1.json", out: "order-archive.json" },
    { source: detailOf(orders[0].billno), out: "order-detail.json" },
    ...(taxed ? [{ source: detailOf(taxed.billno), out: "order-detail-tax.json" }] : []),
    { source: detailOf(archived.billno), out: "order-detail-archived.json" },
    { source: `track-${orders[0].billno.slice(-6)}.html`, out: "track.json", pick: (_p: unknown) => null },
    { source: "unauth-list.json", out: "unauth-list.json" },
  ];

  const results: Array<{ name: string; text: string }> = [];
  for (const spec of specs) {
    const raw = readFileSync(join(CAPTURES, spec.source), "utf8");
    let payload: unknown;
    if (spec.source.endsWith(".html")) {
      const blob = extractTrackSsrData(raw) as Record<string, unknown> | null;
      if (!blob) throw new Error(`sem gbOrdersTrackSsrData em ${spec.source}`);
      payload = blob;
    } else {
      payload = JSON.parse(raw);
      if (spec.pick) payload = spec.pick(payload);
    }
    results.push({ name: spec.out, text: `${JSON.stringify(walk(payload), null, 2)}\n` });
  }

  // Longest first: a short id must never eat a longer one it is a prefix of.
  const ordered = [...globalMap.entries()].sort(([a], [b]) => b.length - a.length);
  for (const item of results) {
    for (const [original, replacement] of ordered) item.text = item.text.split(original).join(replacement);
  }

  let leaks = 0;
  for (const item of results) {
    const found = [...secrets].filter((secret) => secret.length >= 4 && item.text.includes(secret));
    if (found.length > 0) {
      leaks += found.length;
      console.error(`LEAK em ${item.name}: ${found.length} valor(es) originais sobreviveram.`);
      for (const value of found.slice(0, 5)) {
        console.error(`  ${value.slice(0, 4)}… (${value.length} chars) veio do campo \`${secretOrigin.get(value) ?? "?"}\``);
      }
    }
  }
  if (leaks > 0) process.exit(1);

  if (write) {
    mkdirSync(OUT, { recursive: true });
    for (const item of results) writeFileSync(join(OUT, item.name), item.text);
  }
  for (const item of results) console.error(`  ok ${item.name.padEnd(28)} ${item.text.length} bytes`);
  console.error(`\n${idCache.size} ids remapeados, ${wordCache.size} palavras, ${secrets.size} valores no leak guard.`);
  console.error(write ? `\nGravado em ${OUT}.` : "\nDry-run. Rode com --write para gravar.");
}

main();
