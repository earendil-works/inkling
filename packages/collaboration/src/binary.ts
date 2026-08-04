import { Data, Effect } from "effect";

export class BinaryEncodingError extends Data.TaggedError("BinaryEncodingError")<{
  readonly message: string;
}> {}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    output += alphabet[(combined >> 18) & 63] ?? "";
    output += alphabet[(combined >> 12) & 63] ?? "";
    output += index + 1 < bytes.length ? (alphabet[(combined >> 6) & 63] ?? "") : "=";
    output += index + 2 < bytes.length ? (alphabet[combined & 63] ?? "") : "=";
  }
  return output;
}

export function decodeBase64(value: string): Effect.Effect<Uint8Array, BinaryEncodingError> {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return Effect.fail(new BinaryEncodingError({ message: "Invalid base64 data." }));
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = alphabet.indexOf(value[index] ?? "");
    const second = alphabet.indexOf(value[index + 1] ?? "");
    const thirdCharacter = value[index + 2] ?? "=";
    const fourthCharacter = value[index + 3] ?? "=";
    const third = thirdCharacter === "=" ? 0 : alphabet.indexOf(thirdCharacter);
    const fourth = fourthCharacter === "=" ? 0 : alphabet.indexOf(fourthCharacter);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      return Effect.fail(new BinaryEncodingError({ message: "Invalid base64 data." }));
    }
    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < output.length) output[outputIndex] = (combined >> 16) & 255;
    outputIndex += 1;
    if (outputIndex < output.length) output[outputIndex] = (combined >> 8) & 255;
    outputIndex += 1;
    if (outputIndex < output.length) output[outputIndex] = combined & 255;
    outputIndex += 1;
  }
  return Effect.succeed(output);
}
