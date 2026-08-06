import assert from "node:assert/strict";
import test from "node:test";

import { isGoogleEmailAllowed, parseAllowedGoogleDomains } from "../src/google-auth.ts";

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
