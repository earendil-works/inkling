import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRfcPath,
  createBackendApp,
  protectedLinkPath,
  rfcRedirectLocation,
} from "../src/index.ts";

test("RFC routes canonicalize singular, plural, and legacy numeric URLs", async () => {
  assert.equal(canonicalRfcPath(7), "/rfc/0007");
  assert.equal(protectedLinkPath("doc_example", 12, 0), "/auth/link/doc_example/12/0");
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/rfc/0007"), undefined);
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/rfc/0007/edit"), undefined);
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/0007"), "/rfc/0007");
  assert.equal(
    rfcRedirectLocation("https://rfcs.example.com/0007/?source=old"),
    "/rfc/0007?source=old",
  );
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/rfcs/7"), "/rfc/0007");
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/rfcs/0007/edit"), "/rfc/0007/edit");
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/rfc/7/"), "/rfc/0007");
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/rfc/0007/old-slug"), "/rfc/0007");
  assert.equal(rfcRedirectLocation("https://rfcs.example.com/123"), undefined);

  const app = createBackendApp();
  const numeric = await app.request("https://rfcs.example.com/0007/?source=old");
  assert.equal(numeric.status, 308);
  assert.equal(numeric.headers.get("location"), "/rfc/0007?source=old");
  const plural = await app.request("https://rfcs.example.com/rfcs/0007/edit");
  assert.equal(plural.status, 308);
  assert.equal(plural.headers.get("location"), "/rfc/0007/edit");
});
