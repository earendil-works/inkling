import assert from "node:assert/strict";
import test from "node:test";

import { colorFor } from "../src/ui.ts";

test("participant colors are stable and use perceptual OKLCH values", () => {
  const first = colorFor("person_armin");
  const second = colorFor("person_colin");

  assert.equal(first, colorFor("person_armin"));
  assert.match(first, /^oklch\(68% 0\.16 \d+(?:\.\d+)?\)$/u);
  assert.match(second, /^oklch\(68% 0\.16 \d+(?:\.\d+)?\)$/u);
  assert.notEqual(first, second);
});
