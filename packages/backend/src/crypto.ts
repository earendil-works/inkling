import { Effect, Layer } from "effect";

import {
  Digest,
  IdGenerator,
  SecretHasher,
  SecureToken,
  StorageError,
  taggedId,
  uuidV7Bytes,
} from "@earendil-works/inkling-core";
import type {
  DigestService,
  IdGeneratorService,
  SecretHasherService,
  SecureTokenService,
} from "@earendil-works/inkling-core";
import { decodeBase64, encodeBase64 } from "@earendil-works/inkling-collaboration";

const textEncoder = new TextEncoder();
const pbkdf2Iterations = 310_000;

export const DigestLive = Layer.succeed(Digest, {
  sha256: (bytes) =>
    Effect.tryPromise({
      catch: (cause) => cryptoFailure("calculate SHA-256", cause),
      try: () => crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    }).pipe(Effect.map((value) => hex(new Uint8Array(value)))),
} satisfies DigestService);

export const SecureTokenLive = Layer.succeed(SecureToken, {
  generate: (byteLength) =>
    byteLength >= 8 && byteLength <= 1024
      ? Effect.sync(() => base64Url(crypto.getRandomValues(new Uint8Array(byteLength))))
      : Effect.fail(cryptoFailure("generate a secure token", "Invalid token size")),
} satisfies SecureTokenService);

export const IdGeneratorLive = Layer.succeed(IdGenerator, {
  generate: (purpose) =>
    Effect.sync(() =>
      taggedId(purpose, uuidV7Bytes(Date.now(), crypto.getRandomValues(new Uint8Array(10)))),
    ),
} satisfies IdGeneratorService);

export const SecretHasherLive = Layer.succeed(SecretHasher, makeSecretHasher());

function makeSecretHasher(): SecretHasherService {
  return {
    hash: (secret) =>
      Effect.gen(function* () {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const derived = yield* derive(secret, salt, pbkdf2Iterations);
        return `pbkdf2-sha256$${pbkdf2Iterations}$${encodeBase64(salt)}$${encodeBase64(derived)}`;
      }),
    verify: (secret, encodedHash) =>
      Effect.gen(function* () {
        const [algorithm, iterationsValue, saltValue, hashValue, extra] = encodedHash.split("$");
        const iterations = Number(iterationsValue);
        if (
          algorithm !== "pbkdf2-sha256" ||
          extra !== undefined ||
          saltValue === undefined ||
          hashValue === undefined ||
          !Number.isSafeInteger(iterations) ||
          iterations < 100_000 ||
          iterations > 2_000_000
        ) {
          return false;
        }
        const salt = yield* decodeBase64(saltValue).pipe(
          Effect.mapError((cause) => cryptoFailure("decode a secret hash", cause)),
        );
        const expected = yield* decodeBase64(hashValue).pipe(
          Effect.mapError((cause) => cryptoFailure("decode a secret hash", cause)),
        );
        const actual = yield* derive(secret, salt, iterations);
        return constantTimeEqual(actual, expected);
      }),
  };
}

function derive(
  secret: string,
  salt: Uint8Array,
  iterations: number,
): Effect.Effect<Uint8Array, StorageError> {
  return Effect.tryPromise({
    catch: (cause) => cryptoFailure("derive a secret hash", cause),
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
      );
      const bits = await crypto.subtle.deriveBits(
        { hash: "SHA-256", iterations, name: "PBKDF2", salt: new Uint8Array(salt) },
        key,
        256,
      );
      return new Uint8Array(bits);
    },
  });
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left[index % Math.max(1, left.length)] ?? 0) ^
      (right[index % Math.max(1, right.length)] ?? 0);
  }
  return difference === 0;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function cryptoFailure(operation: string, cause: unknown): StorageError {
  return new StorageError({
    cause,
    message: `Cryptographic operation failed while attempting to ${operation}.`,
    operation,
    retryable: false,
  });
}
