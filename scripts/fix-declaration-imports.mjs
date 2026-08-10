import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Usage: fix-declaration-imports.mjs DIRECTORY");

await Promise.all((await declarationFiles(directory)).map(rewriteDeclaration));

async function rewriteDeclaration(filename) {
  const source = await readFile(filename, "utf8");
  const rewritten = source.replace(
    /((?:from|import)\s*(?:\(\s*)?["']\.{1,2}\/[^"']+)\.tsx?(["'])/gu,
    "$1.js$2",
  );
  if (rewritten !== source) await writeFile(filename, rewritten);
}

async function declarationFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(root, entry.name);
      if (entry.isDirectory()) return declarationFiles(filename);
      return Promise.resolve(entry.isFile() && entry.name.endsWith(".d.ts") ? [filename] : []);
    }),
  );
  return nested.flat();
}
