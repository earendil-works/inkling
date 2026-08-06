import { taggedId } from "@earendil-works/jot-core";

export function randomId(tag: string): string {
  return taggedId(tag, crypto.getRandomValues(new Uint8Array(16)));
}

export function documentHref(
  documentId: string,
  shared: boolean,
  mode: "edit" | "read",
  search = location.search,
): string {
  const base = `${shared ? "/share" : "/documents"}/${encodeURIComponent(documentId)}`;
  return `${base}${mode === "edit" ? "/edit" : ""}${search}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(value),
  );
}

export function colorFor(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 58% 46%)`;
}

export function storedGuestName(): string | undefined {
  const existing = localStorage.getItem("jot-guest-name")?.trim();
  return existing === "" ? undefined : existing;
}

export function storeGuestName(displayName: string): void {
  localStorage.setItem("jot-guest-name", displayName);
}
