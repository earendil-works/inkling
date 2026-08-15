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
      : `/rfc/${String(rfcNumber).padStart(4, "0")}`;
  return `${base}${mode === "edit" ? "/edit" : ""}${search}`;
}

export function publicDocumentHref(documentId: string, rfcNumber: number | undefined): string {
  return rfcNumber === undefined
    ? `/public/documents/${encodeURIComponent(documentId)}`
    : `/rfc/${String(rfcNumber).padStart(4, "0")}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(value),
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
