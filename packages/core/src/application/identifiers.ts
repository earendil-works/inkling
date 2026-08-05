const base62Alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const base = BigInt(base62Alphabet.length);

/** Encodes bytes as an unsigned base62 value using Jot's canonical alphabet. */
export function encodeBase62(bytes: ArrayLike<number>): string {
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value << 8n) + BigInt(bytes[index] ?? 0);
  }

  if (value === 0n) return "0";

  let encoded = "";
  while (value > 0n) {
    encoded = base62Alphabet.charAt(Number(value % base)) + encoded;
    value /= base;
  }
  return encoded;
}

/** Adds a readable type tag to base62-encoded random bytes. */
export function taggedId(tag: string, bytes: ArrayLike<number>): string {
  return `${tag}_${encodeBase62(bytes)}`;
}
