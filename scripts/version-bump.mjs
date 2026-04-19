import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(rootDir, "package.json");
const manifestPath = resolve(rootDir, "manifest.json");
const versionsPath = resolve(rootDir, "versions.json");
const packageLockPath = resolve(rootDir, "package-lock.json");

function parseVersion(raw) {
  const match = String(raw || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error("Version must be x.y.z");
  }
  return match.slice(1).map((value) => Number.parseInt(value, 10));
}

function nextVersion(currentVersion, modeOrVersion) {
  if (/^\d+\.\d+\.\d+$/.test(modeOrVersion)) {
    return modeOrVersion;
  }

  const [major, minor, patch] = parseVersion(currentVersion);
  if (modeOrVersion === "patch") return `${major}.${minor}.${patch + 1}`;
  if (modeOrVersion === "minor") return `${major}.${minor + 1}.0`;
  if (modeOrVersion === "major") return `${major + 1}.0.0`;

  throw new Error("Usage: npm run version:bump -- <patch|minor|major|x.y.z>");
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
const rawArg = process.argv[2];

if (!rawArg) {
  throw new Error("Usage: npm run version:bump -- <patch|minor|major|x.y.z>");
}

const version = nextVersion(packageJson.version, rawArg);
packageJson.version = version;
manifestJson.version = version;

const nextVersionsJson = {
  [version]: manifestJson.minAppVersion,
};

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`, "utf8");
await writeFile(versionsPath, `${JSON.stringify(nextVersionsJson, null, 2)}\n`, "utf8");

try {
  const packageLockJson = JSON.parse(await readFile(packageLockPath, "utf8"));
  packageLockJson.version = version;
  if (packageLockJson.packages?.[""]) {
    packageLockJson.packages[""].version = version;
    packageLockJson.packages[""].name = packageJson.name;
  }
  packageLockJson.name = packageJson.name;
  await writeFile(packageLockPath, `${JSON.stringify(packageLockJson, null, 2)}\n`, "utf8");
} catch (error) {
}

console.log(`Bumped version to ${version}`);
