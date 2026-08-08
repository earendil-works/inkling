const base62Alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const base = BigInt(base62Alphabet.length);
const maximumUuidV7Timestamp = 0xffff_ffff_ffff;

export const identifierTag = {
  apiKey: "key",
  attachment: "att",
  capability: "cap",
  clientUpdate: "upd",
  commentMessage: "msg",
  commentThread: "thr",
  document: "doc",
  googleDocument: "gdo",
  guest: "gst",
  import: "imp",
  participant: "par",
  repair: "rep",
  request: "req",
  session: "ses",
  temporaryFile: "tmp",
} as const;

export type IdentifierTag = (typeof identifierTag)[keyof typeof identifierTag];

/** Encodes bytes as an unsigned base62 value using Inkling's canonical alphabet. */
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

/** Builds RFC 9562 UUIDv7 bytes from a Unix millisecond timestamp and random bytes. */
export function uuidV7Bytes(unixMilliseconds: number, randomness: ArrayLike<number>): Uint8Array {
  if (
    !Number.isInteger(unixMilliseconds) ||
    unixMilliseconds < 0 ||
    unixMilliseconds > maximumUuidV7Timestamp
  ) {
    throw new RangeError("UUIDv7 timestamps must be unsigned 48-bit millisecond values.");
  }
  if (randomness.length < 10) {
    throw new RangeError("UUIDv7 generation requires at least 10 random bytes.");
  }
  for (let index = 0; index < 10; index += 1) {
    const value = randomness[index];
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError("UUIDv7 randomness must contain byte values.");
    }
  }

  const bytes = new Uint8Array(16);
  let timestamp = BigInt(unixMilliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | ((randomness[0] ?? 0) & 0x0f);
  bytes[7] = randomness[1] ?? 0;
  bytes[8] = 0x80 | ((randomness[2] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index += 1) {
    bytes[index] = randomness[index - 6] ?? 0;
  }
  return bytes;
}

/** Adds a two- or three-character type tag to base62-encoded identifier bytes. */
export function taggedId(tag: IdentifierTag, bytes: ArrayLike<number>): string {
  if (!/^[a-z][a-z0-9]{1,2}$/u.test(tag)) {
    throw new RangeError("Identifier tags must contain two or three lowercase characters.");
  }
  return `${tag}_${encodeBase62(bytes)}`;
}
