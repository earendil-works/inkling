import { spawn } from "node:child_process";
import path from "node:path";

import { loadReleasePackages, releaseDirectory, rootDirectory } from "./release-workspace.mjs";

await publishPackages(await loadReleasePackages());

async function publishPackages(packages, index = 0) {
  const releasePackage = packages[index];
  if (releasePackage === undefined) return;
  const { manifest, shortName } = releasePackage;
  const specifier = `${manifest.name}@${manifest.version}`;
  if (await packageVersionExists(specifier)) {
    console.log(`Skipping ${specifier}; it is already published.`);
  } else {
    await run(
      "npm",
      ["publish", path.join(releaseDirectory, shortName), "--access", "public", "--provenance"],
      rootDirectory,
    );
    console.log(`Published ${specifier}.`);
  }
  await publishPackages(packages, index + 1);
}

async function packageVersionExists(specifier) {
  const result = await run("npm", ["view", specifier, "version", "--json"], rootDirectory, true);
  if (result.code === 0) return true;
  if (/E404|404 Not Found/u.test(result.output)) return false;
  throw new Error(`Cannot inspect ${specifier}:\n${result.output}`);
}

function run(command, arguments_, cwd, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (capture) resolve({ code, output });
      else if (code === 0) resolve({ code, output });
      else reject(new Error(`${command} ${arguments_.join(" ")} exited with ${code}.`));
    });
  });
}
