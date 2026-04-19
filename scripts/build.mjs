import { chmod, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await copyFile(resolve(rootDir, "src/main.js"), resolve(rootDir, "main.js"));
await copyFile(resolve(rootDir, "src/ocr_pdf.py"), resolve(rootDir, "ocr_pdf.py"));
await chmod(resolve(rootDir, "ocr_pdf.py"), 0o755);
