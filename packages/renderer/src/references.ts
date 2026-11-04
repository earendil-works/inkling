/**
 * References to other documents and their sections.
 *
 * Authors write `<rfc:57#motivation>`, `[](doc:doc_abc#motivation)`, or give
 * the link their own text with `[the motivation](rfc:57#motivation)`. The
 * source stores only the target and a section ID; the label comes from the
 * target's current title and numbered heading, resolved for each reader.
 */

export type ReferenceTarget =
  | { readonly kind: "rfc"; readonly rfcNumber: number }
  | { readonly kind: "document"; readonly documentId: string };

export interface ParsedReference {
  /** Canonical form used to request and look up resolutions. */
  readonly key: string;
  readonly target: ReferenceTarget;
  /** The section ID within the target, without `#`. */
  readonly anchor?: string | undefined;
}

export interface DocumentReference extends ParsedReference {
  /** Position among the document's references, in source order. */
  readonly index: number;
  /** The link destination as it appears in the Markdown source. */
  readonly source: string;
}

export interface ReferenceSection {
  readonly id: string;
  readonly number?: string | undefined;
  readonly text: string;
}

/** What a reader may learn about a reference's target. */
export type ReferenceResolution =
  | {
      readonly status: "available";
      /** The target's reader path, without a fragment. */
      readonly href: string;
      readonly rfcNumber?: number | undefined;
      readonly title: string;
      /** The referenced section; absent when the target has no such section. */
      readonly section?: ReferenceSection | undefined;
    }
  | { readonly status: "unavailable" };

export type ReferenceResolutions = ReadonlyMap<string, ReferenceResolution>;

const rfcReferencePattern = /^rfc:0*([1-9]\d{0,8})(?:#(.*))?$/iu;
const documentReferencePattern = /^doc:([A-Za-z0-9_-]{10,128})(?:#(.*))?$/u;
const anchorPattern = /^[\p{Letter}\p{Number}\p{Mark}_-]{1,200}$/u;

/** Parses an `rfc:` or `doc:` reference destination. */
export function parseReference(destination: string): ParsedReference | undefined {
  const rfc = rfcReferencePattern.exec(destination);
  if (rfc?.[1] !== undefined) {
    const anchor = parseAnchor(rfc[2]);
    if (anchor === null) return undefined;
    const rfcNumber = Number(rfc[1]);
    return {
      anchor,
      key: referenceKey({ kind: "rfc", rfcNumber }, anchor),
      target: { kind: "rfc", rfcNumber },
    };
  }
  const document = documentReferencePattern.exec(destination);
  if (document?.[1] !== undefined) {
    const anchor = parseAnchor(document[2]);
    if (anchor === null) return undefined;
    return {
      anchor,
      key: referenceKey({ documentId: document[1], kind: "document" }, anchor),
      target: { documentId: document[1], kind: "document" },
    };
  }
  return undefined;
}

export function referenceKey(target: ReferenceTarget, anchor?: string | undefined): string {
  const base = target.kind === "rfc" ? `rfc:${target.rfcNumber}` : `doc:${target.documentId}`;
  return anchor === undefined ? base : `${base}#${anchor}`;
}

/** The reader path of a reference target, used until it is resolved. */
export function referenceTargetPath(target: ReferenceTarget): string {
  return target.kind === "rfc"
    ? `/rfc/${formatRfcNumber(target.rfcNumber)}`
    : `/documents/${encodeURIComponent(target.documentId)}`;
}

export function formatRfcNumber(rfcNumber: number): string {
  return String(rfcNumber).padStart(4, "0");
}

/** The text an automatic reference shows to a reader who cannot open its target. */
export function unavailableReferenceLabel(target: ReferenceTarget): string {
  return target.kind === "rfc"
    ? `RFC ${formatRfcNumber(target.rfcNumber)} (unavailable)`
    : "Unavailable document";
}

/** The text an automatic reference shows before its target is resolved. */
export function pendingReferenceLabel(reference: ParsedReference): string {
  return reference.target.kind === "rfc"
    ? `RFC ${formatRfcNumber(reference.target.rfcNumber)}`
    : "Linked document";
}

/** The text an automatic reference shows for a resolved target. */
export function resolvedReferenceLabel(
  reference: ParsedReference,
  resolution: Extract<ReferenceResolution, { readonly status: "available" }>,
): string {
  const rfcNumber =
    resolution.rfcNumber ??
    (reference.target.kind === "rfc" ? reference.target.rfcNumber : undefined);
  const prefix = rfcNumber === undefined ? resolution.title : `RFC ${formatRfcNumber(rfcNumber)}`;
  if (reference.anchor === undefined) {
    return rfcNumber === undefined ? resolution.title : `${prefix}: ${resolution.title}`;
  }
  if (resolution.section === undefined) {
    return `${prefix} (missing section #${reference.anchor})`;
  }
  return `${prefix} ${sectionLabel(resolution.section)}`;
}

/** `§3.2 Motivation` for numbered sections and `› Motivation` otherwise. */
export function sectionLabel(section: Omit<ReferenceSection, "id">, standalone = false): string {
  if (section.number !== undefined) return `§${section.number} ${section.text}`;
  return standalone ? section.text : `› ${section.text}`;
}

/** The document title a section reference shows on hover. */
export function referenceTitle(
  resolution: Extract<ReferenceResolution, { readonly status: "available" }>,
): string {
  return resolution.rfcNumber === undefined
    ? resolution.title
    : `RFC ${formatRfcNumber(resolution.rfcNumber)}: ${resolution.title}`;
}

/**
 * Legacy relative RFC links such as `rfc-57.md#motivation` or `../rfc/57`
 * point at the canonical reader path. Absolute URLs are left alone, so
 * links to IETF RFCs keep their destination.
 */
export function rewriteLegacyRfcUrl(url: string): string | undefined {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(url) || url.startsWith("//")) return undefined;
  const match = /(?:^|\/)rfcs?[-_/]?(\d+)(?:\.md)?(?:#(.*))?$/iu.exec(url);
  if (match?.[1] === undefined) return undefined;
  const rfcNumber = Number(match[1]);
  if (!Number.isSafeInteger(rfcNumber) || rfcNumber < 1) return undefined;
  return `/rfc/${formatRfcNumber(rfcNumber)}${match[2] === undefined ? "" : `#${match[2]}`}`;
}

/**
 * Makes a published body safe to hand to anonymous readers: references whose
 * target they cannot open no longer reveal the section ID. Links go through
 * `redirect` (a sign-in redirect) when the reference has an index; anywhere
 * else, such as in code, the section ID is dropped.
 */
export function redactReferences(
  body: string,
  options: {
    readonly available: (reference: ParsedReference) => boolean;
    readonly redirect: (reference: ParsedReference) => string | undefined;
  },
): string {
  return body.replace(
    /(\[\]\()?(<)?\b((?:rfc|doc):[A-Za-z0-9_-]+(?:#[\p{Letter}\p{Number}\p{Mark}_%-]*)?)(>)?/giu,
    (
      match,
      emptyLink: string | undefined,
      open: string | undefined,
      destination: string,
      close: string | undefined,
    ) => {
      const reference = parseReference(destination);
      if (reference === undefined || options.available(reference)) return match;
      const autolink = open !== undefined && close !== undefined;
      if (!autolink && emptyLink === undefined && reference.anchor === undefined) return match;
      const replacement = options.redirect(reference) ?? referenceKey(reference.target);
      const label = unavailableReferenceLabel(reference.target);
      if (emptyLink !== undefined) {
        return `[${label}](${open ?? ""}${replacement}${close ?? ""}`;
      }
      if (autolink) return `[${label}](${replacement})`;
      return `${open ?? ""}${replacement}${close ?? ""}`;
    },
  );
}

function parseAnchor(raw: string | undefined): string | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return anchorPattern.test(decoded) ? decoded : null;
}
