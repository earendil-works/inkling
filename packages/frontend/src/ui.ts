import { taggedId, uuidV7Bytes } from "@earendil-works/jot-core";

export function randomId(tag: string): string {
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
      : `/rfcs/${String(rfcNumber).padStart(4, "0")}`;
  return `${base}${mode === "edit" ? "/edit" : ""}${search}`;
}

export function publicDocumentHref(documentId: string, rfcNumber: number | undefined): string {
  return rfcNumber === undefined
    ? `/public/documents/${encodeURIComponent(documentId)}`
    : `/rfcs/${String(rfcNumber).padStart(4, "0")}`;
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
  const hue = ((hash / 0xffff_ffff) * 360).toFixed(2);
  return `oklch(68% 0.16 ${hue})`;
}

export function storedGuestName(): string | undefined {
  const existing = localStorage.getItem("jot-guest-name")?.trim();
  return existing === "" ? undefined : existing;
}

export function storeGuestName(displayName: string): void {
  localStorage.setItem("jot-guest-name", displayName);
}
