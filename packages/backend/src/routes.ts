/** Returns the canonical reader path for an RFC number. */
export function canonicalRfcPath(number: number): string {
  return `/rfc/${String(number).padStart(4, "0")}`;
}

/**
 * Returns a canonical redirect for legacy, plural, unpadded, or slash-terminated RFC URLs.
 * Numeric root redirects deliberately cover exactly the four-digit URLs served by the old site.
 */
export function rfcRedirectLocation(requestUrl: string): string | undefined {
  const url = new URL(requestUrl);
  const numeric = /^\/(\d{4})\/?$/u.exec(url.pathname);
  if (numeric?.[1] !== undefined) {
    const number = Number(numeric[1]);
    return Number.isSafeInteger(number) && number > 0
      ? `${canonicalRfcPath(number)}${url.search}`
      : undefined;
  }

  const routed = /^\/(rfc|rfcs)\/(\d+)(?:\/([^/]+))?\/?$/u.exec(url.pathname);
  if (routed?.[1] === undefined || routed[2] === undefined) return undefined;
  const number = Number(routed[2]);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  const suffix = routed[3] === "edit" ? "/edit" : "";
  const canonical = `${canonicalRfcPath(number)}${suffix}`;
  return routed[1] === "rfc" && url.pathname === canonical
    ? undefined
    : `${canonical}${url.search}`;
}
