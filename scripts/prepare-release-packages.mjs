import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadReleasePackages,
  releaseDirectory,
  repository,
  rootDirectory,
} from "./release-workspace.mjs";

const rootManifest = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
const packages = await loadReleasePackages();
const versions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));

await rm(releaseDirectory, { force: true, recursive: true });
await mkdir(releaseDirectory, { recursive: true });

await Promise.all(packages.map(preparePackage));

async function preparePackage(releasePackage) {
  const { directory, manifest, shortName } = releasePackage;
  const outputDirectory = path.join(releaseDirectory, shortName);
  const distDirectory = path.join(directory, "dist");
  await mkdir(outputDirectory, { recursive: true });
  await cp(distDirectory, path.join(outputDirectory, "dist"), { recursive: true });

  const publishedManifest = compact({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    type: manifest.type,
    exports: releaseExports(manifest.exports),
    bin: releaseBin(manifest.bin),
    files: ["dist"],
    engines: manifest.engines ?? { node: rootManifest.engines.node },
    dependencies: releaseDependencies(manifest.dependencies),
    optionalDependencies: releaseDependencies(manifest.optionalDependencies),
    peerDependencies: releaseDependencies(manifest.peerDependencies),
    peerDependenciesMeta: manifest.peerDependenciesMeta,
    repository: {
      type: "git",
      url: `git+https://github.com/${repository}.git`,
      directory: `packages/${shortName}`,
    },
    homepage: `https://github.com/${repository}#readme`,
    bugs: { url: `https://github.com/${repository}/issues` },
    keywords: ["inkling", "markdown", "collaboration"],
    publishConfig: { access: "public", provenance: true },
  });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "package.json"),
      `${JSON.stringify(publishedManifest, undefined, 2)}\n`,
    ),
    writeFile(
      path.join(outputDirectory, "README.md"),
      `# ${manifest.name}\n\n${manifest.description}\n\nPart of [Inkling](https://github.com/${repository}).\n`,
    ),
    ...Object.values(publishedManifest.bin ?? {}).map((target) =>
      chmod(path.join(outputDirectory, target), 0o755),
    ),
  ]);
}

console.log(
  `Prepared ${packages.length} packages in ${path.relative(rootDirectory, releaseDirectory)}.`,
);

function releaseExports(exports) {
  if (exports === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(exports).map(([name, target]) => [name, releaseExportTarget(target)]),
  );
}

function releaseExportTarget(target) {
  if (typeof target !== "string" || !target.startsWith("./src/") || !/\.tsx?$/u.test(target)) {
    return target;
  }
  const base = target.replace(/^\.\/src\//u, "./dist/").replace(/\.tsx?$/u, "");
  return { types: `${base}.d.ts`, import: `${base}.js`, default: `${base}.js` };
}

function releaseBin(bin) {
  if (bin === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(bin).map(([name, target]) => [
      name,
      target.replace(/^\.\/src\//u, "./dist/").replace(/\.tsx?$/u, ".js"),
    ]),
  );
}

function releaseDependencies(dependencies) {
  if (dependencies === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => {
      if (!range.startsWith("workspace:")) return [name, range];
      const version = versions.get(name);
      if (version === undefined) throw new Error(`Unknown workspace dependency ${name}.`);
      const workspaceRange = range.slice("workspace:".length);
      if (workspaceRange === "^") return [name, `^${version}`];
      if (workspaceRange === "~") return [name, `~${version}`];
      return [name, version];
    }),
  );
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
