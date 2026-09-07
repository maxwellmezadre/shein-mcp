// Error taxonomy for everything that talks to Shein. Messages are user-facing
// (pt-BR) and actionable; the classes let callers (http client, sync, tools,
// CLI) branch on the *kind* of failure without parsing text.

export const LOGIN_HINT =
  "Rode `shein login` no terminal (login manual no navegador) ou `shein login --from-browser arc`.";

/**
 * The `bff-api` answered with a `code` other than "0". `code` is stable across
 * locales; `apiMessage` is the site's own text (pt-BR on the Brazilian site).
 */
export class SheinApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly apiMessage: string,
    public readonly path: string,
    hint?: string,
  ) {
    super(`A Shein respondeu ${code} (${apiMessage}) em ${path}` + (hint ? `: ${hint}` : ""));
    this.name = "SheinApiError";
  }
}

/** No session, or Shein rejected it (login page, logged-out code). Fix: `shein login`. */
export class SheinAuthError extends Error {
  constructor(message: string) {
    super(`${message} ${LOGIN_HINT}`);
    this.name = "SheinAuthError";
  }
}

/**
 * Anti-bot / risk-control verdict (challenge page, 403 with an armor code).
 * The transport switches to the browser once; a second verdict disables the
 * client for the rest of the process and persists a cooldown, because
 * retrying is what deepens the block.
 */
export class SheinRiskControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheinRiskControlError";
  }
}

/** Transport-level failure (network, unexpected status/redirect, non-JSON body). */
export class SheinHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SheinHttpError";
  }
}

/** A 429/5xx storm survived every backoff. */
export class RateLimitError extends Error {
  constructor(
    public readonly attempts: number,
    message: string,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** The encrypted session file or its key is unusable. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/** The interactive browser login (or the cookie import) did not complete. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * The SSR blob or the JSON no longer looks like what the parsers expect — the
 * Shein front-end changed. Actionable: `shein doctor` says which layer broke,
 * `docs/REDISCOVERY.md` says how to remap it.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(`${message} Rode \`shein doctor\` para ver qual camada quebrou.`);
    this.name = "ParseError";
  }
}
