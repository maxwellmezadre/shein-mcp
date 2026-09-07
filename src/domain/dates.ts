// Shein sends unix seconds, sometimes as a number and sometimes as a string,
// and uses "0" for "never" (an order that was never paid). Everything the
// tools return is ISO in Brasília time, so a date the user reads here is the
// date they would read on the site.

/** Brazil dropped daylight saving in 2019, so the offset is a constant. */
const OFFSET_MINUTES = -180;
const OFFSET_LABEL = "-03:00";

/** Raw seconds for the cache, or null when the value means "never". */
export function unixOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

/** `1786732708` → `"2026-08-13T10:18:28-03:00"`; "never" → null. */
export function isoFromUnix(value: string | number | null | undefined): string | null {
  const seconds = unixOf(value);
  if (seconds === null) return null;
  const shifted = new Date((seconds + OFFSET_MINUTES * 60) * 1000);
  return `${shifted.toISOString().slice(0, 19)}${OFFSET_LABEL}`;
}
