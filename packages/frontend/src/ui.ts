import { taggedId, uuidV7Bytes } from "@earendil-works/inkling-core";
import type { IdentifierTag } from "@earendil-works/inkling-core";

export function randomId(tag: IdentifierTag): string {
  return taggedId(tag, uuidV7Bytes(Date.now(), crypto.getRandomValues(new Uint8Array(10))));
}

export function documentHref(
  documentId: string,
  rfcNumber: number | undefined,
  shared: boolean,
  mode: "edit" | "read",
  search = location.search,
): string {
  const base = shared
    ? `/share/${encodeURIComponent(documentId)}`
    : rfcNumber === undefined
      ? `/documents/${encodeURIComponent(documentId)}`
      : `/rfc/${formatRfcNumber(rfcNumber)}`;
  return `${base}${mode === "edit" ? "/edit" : ""}${search}`;
}

export function publicDocumentHref(documentId: string, rfcNumber: number | undefined): string {
  return rfcNumber === undefined
    ? `/public/documents/${encodeURIComponent(documentId)}`
    : `/rfc/${formatRfcNumber(rfcNumber)}`;
}

/** Signs in and then returns to `url`. */
export function signInHref(url: URL): string {
  return `/api/auth/google/start?next=${encodeURIComponent(`${url.pathname}${url.search}${url.hash}`)}`;
}

/** An RFC number as Inkling shows and routes it, zero-padded to four digits. */
export function formatRfcNumber(rfcNumber: number): string {
  return String(rfcNumber).padStart(4, "0");
}

/** Names an exported file after the document: `rfc-0042-title` or `title`. */
export function documentExportFileName(
  title: string,
  rfcNumber: number | undefined,
  extension: "docx" | "pdf",
): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  const prefix = rfcNumber === undefined ? "" : `rfc-${formatRfcNumber(rfcNumber)}`;
  const name = [prefix, slug].filter((part) => part !== "").join("-") || "document";
  return `${name}.${extension}`;
}

/** Names a document's kind: its RFC number, or "Note". */
export function documentFolio(rfcNumber: number | undefined): string {
  return rfcNumber === undefined ? "Note" : `RFC ${formatRfcNumber(rfcNumber)}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(value),
  );
}

/** Formats a timestamp's date in the reader's time zone. */
export function formatLocalDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

/** Whether keyboard input at `target` edits text, so single-key shortcuts must not fire. */
export function isEditableElement(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function colorFor(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const lightness = themeNumber("--presence-lightness", 68);
  const chroma = themeNumber("--presence-chroma", 0.16);
  const hueOffset = themeNumber("--presence-hue-offset", 0);
  const hue = (((hash / 0xffff_ffff) * 360 + hueOffset) % 360).toFixed(2);
  return `oklch(${lightness}% ${chroma} ${hue})`;
}

function themeNumber(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) ? value : fallback;
}

export function storedGuestName(): string | undefined {
  const existing = localStorage.getItem("inkling-guest-name")?.trim();
  return existing === "" ? undefined : existing;
}

export function storeGuestName(displayName: string): void {
  localStorage.setItem("inkling-guest-name", displayName);
}
