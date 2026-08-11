import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Effect, Either } from "effect";

import {
  createBackendApp,
  decodeThemeJson,
  defaultTheme,
  findBundledTheme,
  paperTheme,
  themeStylesheet,
} from "../src/index.ts";

test("the bundled themes define validated light, dark, font, syntax, and diagram values", async () => {
  const configurations = await Promise.all(
    (
      [
        ["inkling", defaultTheme],
        ["paper", paperTheme],
      ] as const
    ).map(async ([name, expected]) => {
      const source = await readFile(
        path.resolve(import.meta.dirname, `../../../themes/${name}.json`),
        "utf8",
      );
      return { expected, theme: await Effect.runPromise(decodeThemeJson(source)) };
    }),
  );
  for (const { expected, theme } of configurations) {
    const stylesheet = themeStylesheet(theme);
    const { $schema, ...configuration } = theme;
    assert.equal($schema, "../theme.schema.json");
    assert.deepEqual(configuration, expected);
    assert.match(stylesheet, /:root\[data-theme="dark"\]/u);
    assert.match(stylesheet, /--code-keyword: oklch\(/u);
    assert.match(stylesheet, /--mermaid-primary: oklch\(/u);
    assert.doesNotMatch(stylesheet, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/iu);
  }
  assert.match(themeStylesheet(defaultTheme), /--serif: "Newsreader"/u);
  assert.match(themeStylesheet(paperTheme), /--serif: "Literata"/u);
  assert.notEqual(paperTheme.light.page, defaultTheme.light.page);
  assert.equal(findBundledTheme(undefined), defaultTheme);
  assert.equal(findBundledTheme("inkling"), defaultTheme);
  assert.equal(findBundledTheme("paper"), paperTheme);
});

test("theme JSON rejects colors outside OKLCH", async () => {
  const invalid = {
    ...defaultTheme,
    light: { ...defaultTheme.light, accent: "#ff00ff" },
  };
  const result = await Effect.runPromise(Effect.either(decodeThemeJson(JSON.stringify(invalid))));

  assert.equal(Either.isLeft(result), true);
});

test("the backend serves the selected theme as JSON and CSS", async () => {
  const selected = {
    ...defaultTheme,
    fonts: { ...defaultTheme.fonts, heading: '"Custom Heading", serif' },
    light: { ...defaultTheme.light, accent: "oklch(62% 0.2 25)" },
  };
  const app = createBackendApp({ theme: selected });
  const cssResponse = await app.request("/theme.css");
  const jsonResponse = await app.request("/theme.json");

  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get("content-type") ?? "", /^text\/css/u);
  assert.match(await cssResponse.text(), /--accent: oklch\(62% 0\.2 25\)/u);
  assert.equal(((await jsonResponse.json()) as { name: string }).name, selected.name);
});
