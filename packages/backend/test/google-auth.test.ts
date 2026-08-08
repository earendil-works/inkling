import assert from "node:assert/strict";
import test from "node:test";

import {
  isGoogleEmailAllowed,
  parseAllowedGoogleDomains,
  startGoogleAuthentication,
} from "../src/google-auth.ts";

test("Google sign-in fails closed when allowed-domain configuration is absent", async () => {
  const response = await startGoogleAuthentication(
    new Request("https://rfcs.example.com/api/auth/google/start"),
    {},
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "oauth_unavailable",
    message: "Google authentication is not configured.",
    retryable: false,
  });
});

test("Google sign-in domain allowlists are normalized and matched exactly", () => {
  const domains = parseAllowedGoogleDomains(
    " Example.COM, @writers.example.org,example.com,not a domain ",
  );

  assert.deepEqual(domains, ["example.com", "writers.example.org"]);
  assert.equal(isGoogleEmailAllowed("writer@example.com", domains), true);
  assert.equal(isGoogleEmailAllowed("WRITER@WRITERS.EXAMPLE.ORG", domains), true);
  assert.equal(isGoogleEmailAllowed("writer@notexample.com", domains), false);
  assert.equal(isGoogleEmailAllowed("writer@example.com.attacker.invalid", domains), false);
  assert.equal(isGoogleEmailAllowed("missing-domain", domains), false);
});
