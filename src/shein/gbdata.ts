import { ParseError } from "../core/errors.js";

// The SSR pages hand their data to the client as a JS assignment inside a
// <script>: `var gbRawData = {...};` on the order pages and
// `var gbOrdersTrackSsrData = {...}` on the tracking page. The object is
// followed by more JS on the same script, so it cannot be JSON.parse'd from
// the marker to the end: the extractor balances braces (respecting strings
// and escapes) to find where the object ends. This is the same walk the
// rediscovery session used against the live site.

const GB_RAW_DATA = "var gbRawData = ";
const TRACK_SSR_DATA = "var gbOrdersTrackSsrData = ";

/** Index just past the object/array that starts at `start`, or -1 when unbalanced. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The object assigned right after `marker` (e.g. `var gbRawData = `), or null
 * when the marker is absent — a login page or a changed layout. Malformed
 * data (unbalanced, not JSON) is a {@link ParseError}: the layout changed.
 */
export function extractScriptObject(html: string, marker: string): Record<string, unknown> | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let start = at + marker.length;
  while (start < html.length && /\s/.test(html[start] as string)) start += 1;
  const open = html[start];
  if (open !== "{" && open !== "[") {
    throw new ParseError(`Esperava um objeto depois de \`${marker.trim()}\` e veio \`${open ?? "fim"}\`.`);
  }
  const end = objectEnd(html, start);
  if (end < 0) throw new ParseError(`O objeto depois de \`${marker.trim()}\` não fecha (chaves desbalanceadas).`);
  try {
    return JSON.parse(html.slice(start, end)) as Record<string, unknown>;
  } catch (error) {
    throw new ParseError(
      `O objeto depois de \`${marker.trim()}\` não é JSON válido: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

/** `gbRawData` of the SSR order pages (`/user/orders/list`, `/user/orders/detail/<billno>`). */
export const extractGbRawData = (html: string): Record<string, unknown> | null =>
  extractScriptObject(html, GB_RAW_DATA);

/** `gbOrdersTrackSsrData` of the tracking page (`/orders/track?billno=`). */
export const extractTrackSsrData = (html: string): Record<string, unknown> | null =>
  extractScriptObject(html, TRACK_SSR_DATA);
