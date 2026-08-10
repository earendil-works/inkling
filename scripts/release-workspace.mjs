import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repository = "earendil-works/inkling";
export const releaseWorkflow = "release.yml";
export const releaseEnvironment = "npm";
export const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const releaseDirectory = path.join(rootDirectory, ".release");

export async function loadReleasePackages() {
  const packagesDirectory = path.join(rootDirectory, "packages");
  const directories = await readdir(packagesDirectory, { withFileTypes: true });
  const packages = (
    await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const directory = path.join(packagesDirectory, entry.name);
          const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
          return { directory, manifest, shortName: entry.name };
        }),
    )
  ).filter(({ manifest }) => manifest.private !== true);

  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const ordered = [];
  const remaining = new Map(
    packages.map((releasePackage) => [releasePackage.manifest.name, releasePackage]),
  );
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(({ manifest }) =>
      internalDependencies(manifest, names).every((dependency) => !remaining.has(dependency)),
    );
    if (ready.length === 0) {
      throw new Error(`Circular release package dependencies: ${[...remaining.keys()].join(", ")}`);
    }
    ready.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
    for (const releasePackage of ready) {
      remaining.delete(releasePackage.manifest.name);
      ordered.push(releasePackage);
    }
  }
  return ordered;
}

function internalDependencies(manifest, names) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  return Object.keys(dependencies).filter((name) => names.has(name));
}
