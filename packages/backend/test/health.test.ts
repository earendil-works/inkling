import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { IdGenerator } from "@earendil-works/jot-core";
import type { HealthResponse } from "@earendil-works/jot-protocol";

import { createBackendApp, IdGeneratorLive } from "../src/index.ts";

test("health identifies the service and protocol", async () => {
  const response = await createBackendApp({ version: "test" }).request("/api/health");
  const body = (await response.json()) as HealthResponse;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", /^request_[0-9A-Za-z]+$/u);
  assert.deepEqual(body, {
    protocolVersion: 1,
    service: "jot",
    status: "ok",
    version: "test",
  });
});

test("generated identifiers have tagged base62 values", async () => {
  const id = await Effect.runPromise(
    IdGenerator.pipe(
      Effect.flatMap((identifiers) => identifiers.generate("doc")),
      Effect.provide(IdGeneratorLive),
    ),
  );

  assert.match(id, /^doc_[0-9A-Za-z]+$/u);
});
