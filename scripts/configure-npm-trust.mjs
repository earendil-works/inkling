import { spawn } from "node:child_process";

import {
  loadReleasePackages,
  releaseEnvironment,
  releaseWorkflow,
  repository,
} from "./release-workspace.mjs";

const version = await output("npm", ["--version"]);
const [major = 0, minor = 0] = version.trim().split(".").map(Number);
if (major < 11 || (major === 11 && minor < 15)) {
  throw new Error(`npm 11.15.0 or newer is required; found ${version.trim()}.`);
}

await trustPackages(await loadReleasePackages());

async function trustPackages(packages, index = 0) {
  const releasePackage = packages[index];
  if (releasePackage === undefined) return;
  await run("npm", [
    "trust",
    "github",
    releasePackage.manifest.name,
    "--file",
    releaseWorkflow,
    "--repo",
    repository,
    "--environment",
    releaseEnvironment,
    "--allow-publish",
    "--yes",
  ]);
  await trustPackages(packages, index + 1);
}

function output(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "inherit"] });
    let value = "";
    child.stdout.on("data", (chunk) => (value += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(value)
        : reject(new Error(`${command} ${arguments_.join(" ")} exited with ${code}.`)),
    );
  });
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${arguments_.join(" ")} exited with ${code}.`)),
    );
  });
}
