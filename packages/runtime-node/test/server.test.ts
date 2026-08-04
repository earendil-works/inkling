import assert from "node:assert/strict";
import test from "node:test";

import { parsePort } from "../src/server.ts";

test("parsePort uses the local default", () => {
  assert.equal(parsePort(undefined), 8787);
});

test("parsePort rejects invalid ports", () => {
  assert.throws(() => parsePort("0"), /Invalid PORT/u);
  assert.throws(() => parsePort("banana"), /Invalid PORT/u);
  assert.throws(() => parsePort("65536"), /Invalid PORT/u);
});
