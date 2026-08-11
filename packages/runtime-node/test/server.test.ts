import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Effect } from "effect";

import { defaultTheme, paperTheme } from "@earendil-works/inkling-backend";

import { loadTheme, parsePort } from "../src/server.ts";

test("parsePort uses the local default", () => {
  assert.equal(parsePort(undefined), 8787);
});

test("parsePort rejects invalid ports", () => {
  assert.throws(() => parsePort("0"), /Invalid PORT/u);
  assert.throws(() => parsePort("banana"), /Invalid PORT/u);
  assert.throws(() => parsePort("65536"), /Invalid PORT/u);
});

test("INKLING_THEME selects a bundled theme by name", async () => {
  assert.equal(await Effect.runPromise(loadTheme(undefined)), defaultTheme);
  assert.equal(await Effect.runPromise(loadTheme("inkling")), defaultTheme);
  assert.equal(await Effect.runPromise(loadTheme("paper")), paperTheme);
});

test("INKLING_THEME selects a validated JSON theme file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-theme-"));
  try {
    const selected = {
      ...defaultTheme,
      name: "Selected theme",
      light: { ...defaultTheme.light, accent: "oklch(64% 0.18 220)" },
    };
    await writeFile(path.join(directory, "theme.json"), JSON.stringify(selected));
    const theme = await Effect.runPromise(loadTheme("theme.json", directory));
    assert.equal(theme.name, "Selected theme");
    assert.equal(theme.light.accent, "oklch(64% 0.18 220)");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
