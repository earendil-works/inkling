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
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export function colorFor(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 58% 46%)`;
}

export function guestName(): string {
  const existing = localStorage.getItem("jot-guest-name");
  if (existing !== null && existing.trim() !== "") return existing;
  const entered = window.prompt("Your display name")?.trim() || "Guest";
  localStorage.setItem("jot-guest-name", entered);
  return entered;
}
