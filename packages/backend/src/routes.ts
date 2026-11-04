export function protectedLinkPath(documentId: string, revision: number, linkIndex: number): string {
  return `/auth/link/${encodeURIComponent(documentId)}/${revision}/${linkIndex}`;
}

/** The sign-in redirect behind a reference that anonymous readers see redacted. */
export function referenceLinkPath(
  documentId: string,
  revision: number,
  referenceIndex: number,
): string {
  return `/auth/reference/${encodeURIComponent(documentId)}/${revision}/${referenceIndex}`;
}

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

/**
 * How long browsers may reuse a static frontend file without asking again.
 * Vite fingerprints everything under /assets/, so those URLs never change
 * content. The shell's stylesheets and fonts keep stable URLs, so they are
 * reused briefly; they block rendering, and revalidating them costs a round
 * trip on every page load.
 */
export function staticAssetCacheControl(pathname: string): string | undefined {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/fonts/elanor/files/")) return "public, max-age=86400";
  if (/^\/(?:fonts\/elanor\/)?[\w-]+\.css$/u.test(pathname)) {
    return "public, max-age=300, stale-while-revalidate=86400";
  }
  return undefined;
}
