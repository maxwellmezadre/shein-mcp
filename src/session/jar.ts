// Pure cookie-jar helpers, no I/O. The cookie shape is Playwright's
// (`context.cookies()` / `storageState`), so the login bootstrap persists
// exactly what it captured — including the HttpOnly session cookies that
// `document.cookie` never shows — and the HTTP client rebuilds the `Cookie:`
// header from it.

export type SameSite = "Strict" | "Lax" | "None";

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 = session cookie (Playwright's convention). */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: SameSite;
};

export type MergeResult = {
  cookies: Cookie[];
  /** True when a value or expiry actually changed — the trigger to persist. */
  changed: boolean;
  /** Set-Cookie lines that could not be parsed. */
  skipped: number;
};

const stripDot = (domain: string): string => domain.replace(/^\./, "").toLowerCase();

/**
 * Deliberately liberal: a host-only cookie (`shein.com`) also matches
 * subdomains. The session spans `br.shein.com` and `api-shein.shein.com`, and
 * the RFC 6265 host-only rule would drop cookies the browser itself sent for
 * that same registrable domain.
 */
export function hostMatches(host: string, domain: string): boolean {
  const wanted = stripDot(domain);
  const actual = host.toLowerCase();
  return actual === wanted || actual.endsWith(`.${wanted}`);
}

/**
 * Whether a cookie belongs to the site, i.e. its domain is the registrable
 * domain or a subdomain of it. Note the direction: `hostMatches` asks "would
 * this HOST send this cookie", which drops host-only cookies of subdomains
 * (`br.shein.com`) when filtering a whole jar by `shein.com`.
 */
export function inSiteDomain(cookieDomain: string, registrable: string): boolean {
  const domain = stripDot(cookieDomain);
  const site = stripDot(registrable);
  return domain === site || domain.endsWith(`.${site}`);
}

/** Builds the `Cookie:` header value for `url` from the cookies that apply. */
export function cookieHeader(cookies: readonly Cookie[], url: URL, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  return cookies
    .filter(
      (cookie) =>
        hostMatches(url.hostname, cookie.domain) &&
        // ponytail: prefix match, not the RFC 6265 path-segment rule.
        url.pathname.startsWith(cookie.path) &&
        (cookie.expires === -1 || cookie.expires > nowSeconds) &&
        (!cookie.secure || url.protocol === "https:"),
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

const keyOf = (cookie: Cookie): string => `${cookie.name}|${stripDot(cookie.domain)}|${cookie.path}`;

function expiresOf(parsed: Bun.Cookie, nowSeconds: number): number {
  if (typeof parsed.maxAge === "number") return nowSeconds + parsed.maxAge;
  const { expires } = parsed;
  if (expires instanceof Date) return Math.floor(expires.getTime() / 1000);
  if (typeof expires === "number") return expires > 1e11 ? Math.floor(expires / 1000) : expires;
  return -1;
}

function sameSiteOf(value: string | undefined): SameSite | undefined {
  switch (value) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "none":
      return "None";
    default:
      return undefined;
  }
}

function sameCookie(a: Cookie, b: Cookie): boolean {
  return (
    a.value === b.value &&
    a.expires === b.expires &&
    // Normalised: some parsers keep the leading dot and some drop it, and a
    // spurious difference here would rewrite the session file on every request.
    stripDot(a.domain) === stripDot(b.domain) &&
    a.path === b.path &&
    a.httpOnly === b.httpOnly &&
    a.secure === b.secure
  );
}

/**
 * Applies `Set-Cookie` lines from a response to the jar. Cookies are keyed by
 * (name, domain, path); expired ones (`Max-Age=0`, past `Expires`) are removed.
 * Insertion order is preserved so the `Cookie:` header stays stable.
 */
export function mergeSetCookie(
  cookies: readonly Cookie[],
  lines: readonly string[],
  requestHost: string,
  nowMs: number,
): MergeResult {
  const nowSeconds = Math.floor(nowMs / 1000);
  const next = new Map(cookies.map((cookie) => [keyOf(cookie), cookie]));
  let changed = false;
  let skipped = 0;

  for (const line of lines) {
    let parsed: Bun.Cookie;
    try {
      parsed = Bun.Cookie.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const incoming: Cookie = {
      name: parsed.name,
      value: parsed.value,
      domain: parsed.domain ?? requestHost,
      path: parsed.path || "/",
      expires: expiresOf(parsed, nowSeconds),
      httpOnly: parsed.httpOnly,
      secure: parsed.secure,
      sameSite: sameSiteOf(parsed.sameSite),
    };
    const key = keyOf(incoming);
    const current = next.get(key);
    const dead = incoming.expires !== -1 && incoming.expires <= nowSeconds;
    if (dead) {
      if (current) {
        next.delete(key);
        changed = true;
      }
      continue;
    }
    if (!current || !sameCookie(current, incoming)) {
      next.set(key, incoming);
      changed = true;
    }
  }

  return { cookies: [...next.values()], changed, skipped };
}

export function findCookie(cookies: readonly Cookie[], name: string): Cookie | undefined {
  return cookies.find((cookie) => cookie.name === name);
}

/**
 * `memberId` is the one account cookie the site leaves readable by scripts;
 * its presence is the cheapest "logged in" signal (the session itself is
 * HttpOnly). Never returns an empty string.
 */
export function memberIdFromJar(cookies: readonly Cookie[]): string | null {
  const value = findCookie(cookies, "memberId")?.value.trim();
  return value ? value : null;
}
