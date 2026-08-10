import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { IdGenerator, identifierTag } from "@earendil-works/inkling-core";
import type { HealthResponse } from "@earendil-works/inkling-protocol";

import {
  agentResourceUnavailableResponse,
  createBackendApp,
  IdGeneratorLive,
} from "../src/index.ts";

test("served agent instructions explain personal API keys and safe CLI use", async () => {
  const response = await createBackendApp({ version: "test" }).request(
    "https://rfcs.example.com/AGENTS.md",
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/u);
  assert.match(body, /base URL is https:\/\/rfcs\.example\.com/u);
  assert.match(body, /account menu.*API keys/su);
  assert.match(body, /Reuse an active key.*click \*\*Show\*\*/su);
  assert.match(body, /inkling workspace add https:\/\/rfcs\.example\.com API_KEY/u);
  assert.match(body, /inkling read https:\/\/rfcs\.example\.com\/rfcs\/0057/u);
  assert.match(body, /inkling read rfcs\.example\.com DOCUMENT_ID/u);
  assert.match(body, /Capability .* URLs.*without configuring a workspace/u);
  assert.match(body, /API keys belong to the user who created them/u);
  assert.match(body, /\.agents\/skills\/inkling\/SKILL\.md/u);
  assert.match(body, /never contain an API key/u);
});

test("unavailable resources put the agent handoff at the start of default HTML", async () => {
  const response = agentResourceUnavailableResponse("https://rfcs.example.com/rfcs/0057");
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/u);
  assert.match(response.headers.get("link") ?? "", /<https:\/\/rfcs\.example\.com\/AGENTS\.md>/u);
  assert.ok(body.indexOf("INKLING AGENT HANDOFF") < 128);
  assert.ok(body.indexOf("/AGENTS.md") < 256);
  const visibleBody = body.slice(body.indexOf("<body>"));
  assert.match(visibleBody, /INKLING AGENT HANDOFF/u);
  assert.match(visibleBody, /do not summarize this application response/u);
  assert.match(visibleBody, /inkling read/u);
  assert.doesNotMatch(body, /0057/u);
});

test("health identifies the service and protocol", async () => {
  const response = await createBackendApp({ version: "test" }).request("/api/health");
  const body = (await response.json()) as HealthResponse;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", /^req_[0-9A-Za-z]+$/u);
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
      Effect.flatMap((identifiers) => identifiers.generate(identifierTag.document)),
      Effect.provide(IdGeneratorLive),
    ),
  );

  assert.match(id, /^doc_[0-9A-Za-z]+$/u);
});
