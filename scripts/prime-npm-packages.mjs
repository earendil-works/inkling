import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadReleasePackages, repository } from "./release-workspace.mjs";

await primePackages(await loadReleasePackages());

async function primePackages(packages, index = 0) {
  const releasePackage = packages[index];
  if (releasePackage === undefined) return;
  const { manifest } = releasePackage;
  if (await packageExists(manifest.name)) {
    console.log(`Skipping ${manifest.name}; it already exists on npm.`);
  } else {
    await primePackage(manifest);
  }
  await primePackages(packages, index + 1);
}

async function primePackage(manifest) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inkling-npm-prime-"));
  try {
    const writes = [
      writeFile(
        path.join(directory, "package.json"),
        `${JSON.stringify(
          {
            name: manifest.name,
            version: "0.0.0",
            description: "Placeholder package used to configure npm trusted publishing.",
            repository: `https://github.com/${repository}.git`,
            publishConfig: { access: "public" },
          },
          undefined,
          2,
        )}\n`,
      ),
      writeFile(
        path.join(directory, "README.md"),
        `# ${manifest.name}\n\nThis empty placeholder exists only to configure npm trusted publishing. Do not depend on it.\n`,
      ),
    ];
    if (process.env["NPM_TOKEN"] !== undefined) {
      writes.push(
        writeFile(
          path.join(directory, ".npmrc"),
          "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
          { mode: 0o600 },
        ),
      );
    }
    await Promise.all(writes);
    await run("npm", ["publish", "--access", "public"], directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function packageExists(name) {
  const result = await run("npm", ["view", name, "version", "--json"], process.cwd(), true);
  if (result.code === 0) return true;
  if (/E404|404 Not Found/u.test(result.output)) return false;
  throw new Error(`Cannot inspect ${name}:\n${result.output}`);
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
