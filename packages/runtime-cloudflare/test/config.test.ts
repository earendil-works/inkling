import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);

test("Cloudflare deployment retains its pre-branding resource identities", async () => {
  const config = await readFile(configUrl, "utf8");

  assert.match(config, /"name": "jot"/u);
  assert.match(config, /"bucket_name": "jot-objects"/u);
  assert.match(config, /"preview_bucket_name": "jot-objects-preview"/u);
  assert.match(config, /"name": "INKLING_WORKSPACE"/u);
  assert.match(config, /"name": "INKLING_DOCUMENTS"/u);
  assert.match(config, /"binding": "INKLING_OBJECTS"/u);
});
