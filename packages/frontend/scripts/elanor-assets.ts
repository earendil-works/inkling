import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * The application shell and the server-rendered public and OAuth pages share
 * Elanor's fonts and tokens. The server pages are not Vite entry points, so they
 * need stable URLs: serve Elanor's fonts unchanged at /fonts/elanor/ and the
 * `earendil` brand tokens followed by Inkling's domain tokens at /tokens.css, in
 * development and in the build. Relative URLs inside the font CSS stay intact,
 * and every page links the same files, so browsers cache one copy.
 */
export function elanorAssets(): Plugin {
  const brandTokens = require.resolve("@earendil-works/design-tokens/earendil.css");
  const domainTokens = new URL("../src/styles/tokens.css", import.meta.url);
  const tokens = (): Buffer =>
    Buffer.concat([readFileSync(brandTokens), Buffer.from("\n"), readFileSync(domainTokens)]);
  const fontRoot = dirname(require.resolve("@earendil-works/elanor-fonts/mallos-serif.css"));
  const fontFiles = [
    "mallos-serif.css",
    "commit-mono.css",
    ...["files", "licenses"].flatMap((directory) =>
      readdirSync(join(fontRoot, directory)).map((file) => `${directory}/${file}`),
    ),
  ];
  const fonts = new Map<string, Buffer>(
    fontFiles.map((file) => [`/fonts/elanor/${file}`, readFileSync(join(fontRoot, file))] as const),
  );
  // Read on each request in development, so token edits show on reload.
  const asset = (path: string): Buffer | undefined =>
    path === "/tokens.css" ? tokens() : fonts.get(path);

  return {
    name: "inkling-elanor-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0] ?? "";
        const source = asset(path);
        if (source === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
          next();
          return;
        }
        response.setHeader("Content-Type", MIME_TYPES[extname(path)] ?? "application/octet-stream");
        response.setHeader("Content-Length", source.length);
        response.setHeader("Cache-Control", "no-cache");
        response.end(request.method === "HEAD" ? undefined : source);
      });
    },
    generateBundle() {
      for (const [path, source] of [...fonts, ["/tokens.css", tokens()] as const]) {
        this.emitFile({ fileName: path.slice(1), source, type: "asset" });
      }
    },
  };
}
