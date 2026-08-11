import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const frontendRoot = path.resolve(import.meta.dirname, "..");

test("frontend styles contain no fixed legacy colors", async () => {
  const files = [
    ...(await cssFiles(path.join(frontendRoot, "src"))),
    ...(await cssFiles(path.join(frontendRoot, "public"))),
  ];
  const stylesheets = await Promise.all(files.map((filename) => readFile(filename, "utf8")));
  for (const [index, css] of stylesheets.entries()) {
    assert.doesNotMatch(
      css,
      /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<!--)\btransparent\b|color-mix\(in (?:srgb|oklab)/iu,
      files[index],
    );
  }
});

async function cssFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? cssFiles(filename)
        : Promise.resolve(filename.endsWith(".css") ? [filename] : []);
    }),
  );
  return files.flat();
}
