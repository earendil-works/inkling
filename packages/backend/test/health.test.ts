import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { IdGenerator } from "@earendil-works/inkling-core";
import type { HealthResponse } from "@earendil-works/inkling-protocol";

import { createBackendApp, IdGeneratorLive } from "../src/index.ts";

test("served agent instructions explain personal API keys and safe CLI use", async () => {
  const response = await createBackendApp({ version: "test" }).request(
    "https://rfcs.example.com/AGENTS.md",
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/u);
  assert.match(body, /base URL is https:\/\/rfcs\.example\.com/u);
  assert.match(body, /account menu.*API keys/su);
  assert.match(body, /API keys belong to the user who created them/u);
  assert.match(body, /\.agents\/skills\/inkling\/SKILL\.md/u);
  assert.match(body, /never contain an API key/u);
});

test("health identifies the service and protocol", async () => {
  const response = await createBackendApp({ version: "test" }).request("/api/health");
  const body = (await response.json()) as HealthResponse;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", /^request_[0-9A-Za-z]+$/u);
  assert.deepEqual(body, {
    protocolVersion: 1,
    service: "inkling",
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
