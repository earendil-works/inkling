import { spawn } from "node:child_process";
import path from "node:path";

import { loadReleasePackages, releaseDirectory } from "./release-workspace.mjs";

await Promise.all((await loadReleasePackages()).map(verifyPackage));

async function verifyPackage({ manifest, shortName }) {
  const directory = path.join(releaseDirectory, shortName);
  await run("npm", ["pack", "--dry-run", "--json"], directory);
  console.log(`Verified ${manifest.name}@${manifest.version}.`);
}

function run(command, arguments_, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${arguments_.join(" ")} exited with ${code}.`)),
    );
  });
}
