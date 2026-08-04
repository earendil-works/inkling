import assert from "node:assert/strict";
import test from "node:test";

import type { HealthResponse } from "@earendil-works/jot-protocol";

import { createBackendApp } from "../src/index.ts";

test("health identifies the service and protocol", async () => {
  const response = await createBackendApp({ version: "test" }).request("/api/health");
  const body = (await response.json()) as HealthResponse;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    protocolVersion: 1,
    service: "jot",
    status: "ok",
    version: "test",
  });
});
