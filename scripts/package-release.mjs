import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");
const manifest = JSON.parse(await readFile(resolve(rootDir, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
const versionsJson = JSON.parse(await readFile(resolve(rootDir, "versions.json"), "utf8"));

if (manifest.version !== packageJson.version) {
  throw new Error("manifest.json and package.json versions must match.");
}

if (!versionsJson[manifest.version]) {
  throw new Error(`versions.json is missing ${manifest.version}.`);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
  await cp(resolve(rootDir, fileName), resolve(distDir, fileName));
}

const bundleDir = resolve(distDir, `${manifest.id}-${manifest.version}`);
await mkdir(bundleDir, { recursive: true });

for (const fileName of [
  "main.js",
  "manifest.json",
  "styles.css",
  "ocr_pdf.py",
  "README.md",
  "LICENSE",
]) {
  await cp(resolve(rootDir, fileName), resolve(bundleDir, fileName));
}

execFileSync(
  "zip",
  ["-r", `${manifest.id}-${manifest.version}.zip`, `${manifest.id}-${manifest.version}`],
  { cwd: distDir, stdio: "inherit" }
);

console.log(`Release assets prepared in ${distDir}`);
