import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadReleasePackages } from "./release-workspace.mjs";

const [requestedVersion, ...extraArguments] = process.argv.slice(2);
if (requestedVersion === undefined || extraArguments.length > 0) {
  throw new Error("Usage: pnpm release:version <major.minor.patch>");
}

const requestedParts = parseVersion(requestedVersion);
const packages = await loadReleasePackages();
const currentVersions = new Set(packages.map(({ manifest }) => manifest.version));
if (currentVersions.size !== 1) {
  throw new Error(`Release package versions differ: ${[...currentVersions].join(", ")}`);
}

const currentVersion = [...currentVersions][0];
const currentParts = parseVersion(currentVersion);
const comparison = compareVersions(requestedParts, currentParts);
if (comparison < 0) {
  throw new Error(`Release version ${requestedVersion} is older than ${currentVersion}.`);
}
if (comparison === 0) {
  console.log(`All ${packages.length} release packages are already at ${requestedVersion}.`);
} else {
  await Promise.all(
    packages.map(({ directory, manifest }) =>
      writeFile(
        path.join(directory, "package.json"),
        `${JSON.stringify({ ...manifest, version: requestedVersion }, undefined, 2)}\n`,
      ),
    ),
  );
  console.log(`Set ${packages.length} release packages to ${requestedVersion}.`);
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null) {
    throw new Error(`Release version must be a stable semantic version; received ${version}.`);
  }
  return match.slice(1).map(BigInt);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}
