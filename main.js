"use strict";

const {
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  TFolder,
  normalizePath
} = require("obsidian");
const { execFile } = require("child_process");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const VIEW_TYPE = "smart-import-inbox-view";
const SUPPORTED_EXTENSION_LIST = ["doc", "docx", "xls", "xlsx", "pdf", "pptx", "md", "txt", "epub", "mobi", "azw3"];
const SUPPORTED_EXTENSIONS = new Set(SUPPORTED_EXTENSION_LIST);
const EBOOK_EXTENSIONS = new Set(["epub", "mobi", "azw3"]);
const SUPPORTED_FILE_TYPES_LABEL = "Word、Excel、PDF、PPT、Markdown、TXT、EPUB、MOBI、AZW3";
const SUPPORTED_FILE_EXTENSIONS_LABEL = "doc/docx/xls/xlsx/pdf/pptx/md/txt/epub/mobi/azw3";
const SUPPORTED_FILE_INPUT_ACCEPT = SUPPORTED_EXTENSION_LIST.map((extension) => `.${extension}`).join(",");
const DISCOVERABLE_FALLBACK_EXTENSIONS = new Set(["csv", "rtf", "html", "htm", "odt", "ods", "odp", "ppt", "pptm", "docm"]);
const INTERNAL_ROOT_DIR = ".openclaw";
const INTERNAL_SOURCE_DIR = `${INTERNAL_ROOT_DIR}/source-files`;
const INTERNAL_RECORDS_DIR = `${INTERNAL_ROOT_DIR}/import-records`;
const INTERNAL_ACTIVITY_DIR = `${INTERNAL_ROOT_DIR}/file-activities`;
const INTERNAL_ACTIVITY_EVENTS_DIR = `${INTERNAL_ACTIVITY_DIR}/events`;
const INTERNAL_ACTIVITY_STORE_PATH = `${INTERNAL_ACTIVITY_DIR}/activity-store.json`;
const ACTIVITY_BUS_EVENT = "openclaw:file-activity";
const ACTIVITY_STORE_VERSION = 1;
const TRACKED_ACTIVITY_EXTENSIONS = new Set(["md", "pdf", "doc", "docx", "pptx", "xls", "xlsx", "epub", "mobi", "azw3"]);
const IGNORED_ACTIVITY_PATH_PATTERNS = [
  /^\.openclaw(\/|$)/i,
  /^\.obsidian(\/|$)/i,
  /^Inbox\/_assets(\/|$)/i,
  /(^|\/)(_assets|assets|attachments?|tmp|temp|cache|caches|logs?)(\/|$)/i
];

const DEFAULT_SETTINGS = {
  converterPath: "",
  outputDir: "Inbox",
  keepOriginal: true,
  enableAiSuggestions: true,
  recentDownloadsLookbackMinutes: 120,
  confirmBeforeDelete: true,
  importedNoteWidthMode: "wide",
  activitySortMode: "recent_entered",
  aiProvider: "rules",
  aiProviderBaseUrl: "https://api.openai.com/v1",
  aiProviderModel: "",
  aiProviderApiKey: "",
  dependencyWizardLastPromptedVersion: ""
};

const LOCAL_DEPENDENCY_REQUIREMENTS = {
  required: [
    "markitdown：导入 docx、pdf、pptx、xlsx、xls 等需要先转换成 Markdown 的文件时必需，也可处理部分电子书格式。"
  ],
  optional: [
    "python3：PDF OCR 备用链路依赖。",
    "tesseract：扫描版 PDF 的 OCR 识别依赖。",
    "pypdfium2：OCR 脚本的 Python 依赖。",
    "LibreOffice / soffice：导入旧版 .doc 文件时先转成 .docx。",
    "pandoc：EPUB 电子书导入的备用转换器。",
    "Calibre / ebook-convert：MOBI、AZW3 电子书导入的备用转换器。"
  ],
  notes: [
    "md、txt 可直接导入，不依赖上述转换工具。",
    "缺少可选依赖时，只有对应格式或 OCR 能力会受影响。"
  ]
};

const EMBEDDED_PDF_OCR_SCRIPT = String.raw`#!/usr/bin/env python3

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import pypdfium2 as pdfium


def render_page_image(page, output_path: Path, scale: float) -> None:
    bitmap = page.render(scale=scale)
    image = bitmap.to_pil()
    image.save(output_path)


def run_tesseract(image_path: Path, languages: str) -> str:
    result = subprocess.run(
        [
            "tesseract",
            str(image_path),
            "stdout",
            "-l",
            languages,
            "--psm",
            "3",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def normalize_page_text(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    compact = []
    blank_pending = False

    for raw in lines:
      line = raw.strip()
      if not line:
          blank_pending = True
          continue

      if blank_pending and compact:
          compact.append("")
      compact.append(line)
      blank_pending = False

    return "\n".join(compact).strip()


def extract_pdf_markdown(input_path: Path, scale: float, languages: str) -> str:
    document = pdfium.PdfDocument(str(input_path))
    pages = []

    with tempfile.TemporaryDirectory(prefix="smart-import-ocr-") as temp_dir:
        temp_root = Path(temp_dir)
        for index in range(len(document)):
            page = document[index]
            image_path = temp_root / f"page-{index + 1}.png"
            render_page_image(page, image_path, scale)
            page_text = normalize_page_text(run_tesseract(image_path, languages))
            if page_text:
                pages.append(f"## 第 {index + 1} 页\n\n{page_text}")

    return "\n\n".join(pages).strip() + "\n" if pages else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=2.4)
    parser.add_argument("--languages", default="chi_sim+eng")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    markdown = extract_pdf_markdown(input_path, args.scale, args.languages)
    output_path.write_text(markdown, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

const IMPORTED_NOTE_WIDTH_MODES = ["standard", "wide", "full"];

const STATUS_META = {
  received: { label: "已接收", tone: "neutral" },
  converting: { label: "转换中", tone: "working" },
  imported_to_inbox: { label: "已导入", tone: "success" },
  partial_success: { label: "部分成功", tone: "warning" },
  failed: { label: "失败", tone: "danger" }
};

function showProgressNotice(existingNotice, message, timeout = 0) {
  if (existingNotice && existingNotice.noticeEl) {
    existingNotice.noticeEl.setText(String(message || ""));
    if (typeof existingNotice.hide === "function" && timeout > 0) {
      window.setTimeout(() => {
        existingNotice.hide();
      }, timeout);
    }
    return existingNotice;
  }

  return new Notice(String(message || ""), timeout);
}

function summarizeImportErrorForNotice(errorOrMessage, extension, fallback = "操作失败。", maxLength = 90) {
  const raw = typeof errorOrMessage === "string"
    ? errorOrMessage
    : (errorOrMessage && (errorOrMessage.stderr || errorOrMessage.message)) || fallback;
  const message = String(raw || fallback).replace(/\s+/g, " ").trim().replace(/^Error:\s*/i, "") || fallback;
  if (EBOOK_EXTENSIONS.has(String(extension || "").toLowerCase())) {
    if (/unsupported|not supported|no converter|ebook-convert|pandoc|calibre|format|转换|converter/i.test(message)) {
      return `${String(extension || "").toUpperCase()} 电子书转换失败，请安装 Calibre（ebook-convert）或可处理电子书的 markitdown/pandoc 环境。`;
    }
  }
  if (/ENOENT|no such file|not found|找不到|未找到/i.test(message)) {
    return "文件不存在或路径不可访问。";
  }
  if (/EACCES|EPERM|permission|权限/i.test(message)) {
    return "没有权限访问该文件。";
  }
  if (/timeout|timed out|超时/i.test(message)) {
    return "处理超时，请稍后重试或换用较小文件。";
  }
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}

function normalizeImportedNoteWidthMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return IMPORTED_NOTE_WIDTH_MODES.includes(normalized) ? normalized : DEFAULT_SETTINGS.importedNoteWidthMode;
}

function getImportedNoteWidthLabel(value) {
  const mode = normalizeImportedNoteWidthMode(value);
  if (mode === "standard") return "标准";
  if (mode === "full") return "全宽";
  return "宽版";
}

function getNextImportedNoteWidthMode(value) {
  const current = normalizeImportedNoteWidthMode(value);
  const index = IMPORTED_NOTE_WIDTH_MODES.indexOf(current);
  return IMPORTED_NOTE_WIDTH_MODES[(index + 1) % IMPORTED_NOTE_WIDTH_MODES.length];
}

function normalizeActivitySortMode(value) {
  return String(value || "").trim() === "recent_edited" ? "recent_edited" : "recent_entered";
}

function getActivitySourceLabel(sourceModule) {
  const normalized = String(sourceModule || "").trim().toLowerCase();
  if (normalized === "import") return "导入资料";
  if (normalized === "workflow") return "工作流";
  if (normalized === "manual") return "手动文件";
  return "平台文件";
}

function inferActivityFileType(filePath, fallbackType = "") {
  const preferred = String(fallbackType || "").trim().toLowerCase();
  if (preferred) {
    return preferred;
  }

  return path.extname(String(filePath || "")).slice(1).toLowerCase();
}

function isInternalActivityPath(filePath) {
  const normalized = normalizePath(String(filePath || ""));
  if (!normalized) {
    return true;
  }

  if (IGNORED_ACTIVITY_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const extension = path.extname(normalized).slice(1).toLowerCase();
  return extension === "json";
}

function isBusinessActivityPath(filePath) {
  const normalized = normalizePath(String(filePath || ""));
  if (!normalized || isInternalActivityPath(normalized)) {
    return false;
  }

  if (/\/\.[^/]+/.test(normalized)) {
    return false;
  }

  const extension = path.extname(normalized).slice(1).toLowerCase();
  return TRACKED_ACTIVITY_EXTENSIONS.has(extension);
}

function isTrackedActivityPath(filePath) {
  return isBusinessActivityPath(filePath);
}

function getActivityLocationLabel(filePath) {
  const normalized = normalizePath(String(filePath || ""));
  if (!normalized) {
    return "未知位置";
  }

  const directory = path.posix.dirname(normalized);
  return directory === "." ? "Vault 根目录" : directory;
}

function createActivityEventId() {
  return `activity-${createJobId()}`;
}

function createActivityCardId() {
  return `card-${createJobId()}`;
}

function normalizeActivityEvent(input) {
  const source = input && typeof input === "object" ? input : {};
  const filePath = normalizePath(String(source.filePath || source.outputNotePath || "").trim());
  const fileType = inferActivityFileType(filePath, source.fileType);
  return {
    id: String(source.id || createActivityEventId()),
    eventType: String(source.eventType || "file_created").trim() || "file_created",
    sourceModule: String(source.sourceModule || "unknown").trim() || "unknown",
    filePath,
    fileName: String(source.fileName || path.basename(filePath || "")).trim() || "未命名文件",
    fileType,
    timestamp: String(source.timestamp || getTimestamp()),
    metadata: source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {}
  };
}

function buildActivityStorePayload(cards) {
  return JSON.stringify(
    {
      version: ACTIVITY_STORE_VERSION,
      updatedAt: getTimestamp(),
      cards
    },
    null,
    2
  );
}

function stripMarkdownFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) {
    return text;
  }

  const match = text.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? text.slice(match[0].length) : text;
}

function hashActivityContent(content) {
  return String(stripMarkdownFrontmatter(content) || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function inferActivitySourceFromPath(filePath) {
  const normalized = normalizePath(String(filePath || ""));
  if (!normalized) {
    return "unknown";
  }

  return "manual";
}

function mergeActivityMetadata(existingMetadata, nextMetadata) {
  const base = existingMetadata && typeof existingMetadata === "object" ? existingMetadata : {};
  const incoming = nextMetadata && typeof nextMetadata === "object" ? nextMetadata : {};
  return {
    ...base,
    ...incoming
  };
}

function findExistingActivityCard(cards, event) {
  const list = Array.isArray(cards) ? cards : [];
  const metadata = event.metadata || {};
  const currentPath = normalizePath(event.filePath || "");
  const previousPath = normalizePath(metadata.previousFilePath || "");
  const importRecordPath = normalizePath(metadata.importRecordPath || "");

  return (
    list.find((card) => String(card.id || "") === String(metadata.cardId || "")) ||
    (importRecordPath
      ? list.find((card) => normalizePath(card.metadata && card.metadata.importRecordPath || "") === importRecordPath)
      : null) ||
    (previousPath ? list.find((card) => normalizePath(card.filePath || "") === previousPath) : null) ||
    (currentPath ? list.find((card) => normalizePath(card.filePath || "") === currentPath) : null) ||
    null
  );
}

function buildActivityCardFromEvent(existingCard, event) {
  const metadata = mergeActivityMetadata(existingCard && existingCard.metadata, event.metadata);
  const filePath = normalizePath(event.filePath || existingCard && existingCard.filePath || "");
  const fileName = String(event.fileName || existingCard && existingCard.fileName || path.basename(filePath || "")).trim() || "未命名文件";
  const fileType = inferActivityFileType(filePath, event.fileType || existingCard && existingCard.fileType || "");
  const existingSource = String(existingCard && existingCard.sourceModule || "");
  const incomingSource = String(event.sourceModule || "").trim() || "unknown";
  const sourceModule =
    (existingSource && !["unknown", "manual"].includes(existingSource) && ["unknown", "manual"].includes(incomingSource))
      ? existingSource
      : incomingSource;

  const status = String(
    metadata.status ||
    (existingCard && existingCard.status) ||
    (event.eventType === "file_imported" && metadata.importStatus === "failed" ? "failed" : "ready")
  ).trim() || "ready";

  const canOpen = metadata.canOpen != null ? Boolean(metadata.canOpen) : status !== "failed";
  const canRelocate = metadata.canRelocate != null ? Boolean(metadata.canRelocate) : status !== "failed";

  return {
    id: existingCard && existingCard.id ? existingCard.id : createActivityCardId(),
    fileName,
    filePath,
    fileType,
    sourceModule,
    eventType: String(event.eventType || existingCard && existingCard.eventType || "file_created"),
    enteredAt: String(
      (event.eventType === "file_imported" ? event.timestamp : null) ||
      (existingCard && existingCard.enteredAt) ||
      metadata.enteredAt ||
      event.timestamp ||
      getTimestamp()
    ),
    lastEditedAt: String(
      metadata.lastEditedAt ||
      existingCard && existingCard.lastEditedAt ||
      ""
    ).trim() || null,
    locationLabel: getActivityLocationLabel(filePath),
    status,
    canOpen,
    canRelocate,
    metadata
  };
}

function sortActivityCards(cards, sortMode) {
  const mode = normalizeActivitySortMode(sortMode);
  const list = Array.isArray(cards) ? [...cards] : [];
  list.sort((left, right) => {
    const leftKey = mode === "recent_edited" ? (left.lastEditedAt || left.enteredAt || "") : (left.enteredAt || "");
    const rightKey = mode === "recent_edited" ? (right.lastEditedAt || right.enteredAt || "") : (right.enteredAt || "");
    const leftTime = new Date(leftKey || 0).getTime();
    const rightTime = new Date(rightKey || 0).getTime();
    return rightTime - leftTime;
  });
  return list;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const opts = { timeout: 120_000, ...options };
    execFile(file, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "import";
}

function getTimestamp() {
  return new Date().toISOString();
}

function createJobId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

function yamlString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

function cleanDisplayName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|[\]#^]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "导入文件";
}

function normalizePastedTextContent(value) {
  const raw = String(value || "").replace(/\r\n/g, "\n");
  if (!raw.trim()) {
    return "";
  }

  if (!raw.includes("\n") && /\\r\\n|\\n|\\r|\\t/.test(raw)) {
    return raw
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t")
      .trim();
  }

  return raw.trim();
}

function buildUrlImportTitle(normalizedUrl, pageTitle, hostname) {
  const directTitle = cleanDisplayName(pageTitle).slice(0, 60);
  if (directTitle) {
    return directTitle;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const meaningfulSegment = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean)
      .find((segment) => /[\u4e00-\u9fffA-Za-z]/.test(segment) && !/^p$/i.test(segment));
    const fallback = cleanDisplayName(
      meaningfulSegment ? `${hostname} ${meaningfulSegment}` : `${hostname} 网页导入`
    ).slice(0, 60);
    if (fallback) {
      return fallback;
    }
  } catch {}

  return cleanDisplayName(`${hostname} 网页导入`).slice(0, 60) || "网页内容导入";
}

async function findCommandPath(commandName) {
  const directPath = await findCommandPathInDirectories(commandName, getCommandSearchDirectories());
  if (directPath) {
    return directPath;
  }

  const shellCandidates = getCommandSearchShellCandidates();
  for (const shellPath of shellCandidates) {
    const shellResolved = await findCommandPathViaShell(shellPath, commandName);
    if (shellResolved) {
      return shellResolved;
    }
  }

  const quotedCommandName = String(commandName).replace(/'/g, `'\\''`);
  try {
    const response = await execFileAsync("/bin/sh", ["-lc", `command -v '${quotedCommandName}'`]);
    const resolvedPath = String(response.stdout || "").trim().split(/\r?\n/)[0] || "";
    return await isExecutableFile(resolvedPath) ? resolvedPath : "";
  } catch {
    return "";
  }
}

function getCommandSearchDirectories() {
  const homeDir = os.homedir();
  const pathEntries = String(process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const preferredDirectories = [
    path.join(homeDir, ".local/bin"),
    path.join(homeDir, ".npm-global/bin"),
    path.join(homeDir, ".cargo/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin"
  ];

  return uniqueStrings([...pathEntries, ...preferredDirectories]);
}

function getCommandSearchShellCandidates() {
  const configuredShell = String(process.env.SHELL || "").trim();
  const candidates = configuredShell ? [configuredShell] : [];

  if (process.platform === "darwin") {
    candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  } else if (process.platform === "win32") {
    candidates.push("powershell.exe");
  } else {
    candidates.push("/bin/bash", "/bin/sh");
  }

  return uniqueStrings(candidates);
}

async function isExecutableFile(targetPath) {
  try {
    await fs.access(targetPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findCommandPathInDirectories(commandName, directories) {
  const executableSuffixes = process.platform === "win32"
    ? uniqueStrings((process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((item) => item.toLowerCase()))
    : [""];

  for (const directoryPath of directories) {
    if (!directoryPath) {
      continue;
    }

    for (const suffix of executableSuffixes) {
      const candidate = path.join(directoryPath, process.platform === "win32" ? `${commandName}${suffix}` : commandName);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

async function findCommandPathViaShell(shellPath, commandName) {
  if (!shellPath) {
    return "";
  }

  const shellName = path.basename(shellPath).toLowerCase();
  const quotedCommandName = String(commandName).replace(/'/g, `'\\''`);
  const shellArgs = shellName.includes("zsh") || shellName.includes("bash")
    ? ["-lic", `command -v '${quotedCommandName}'`]
    : ["-lc", `command -v '${quotedCommandName}'`];

  try {
    const response = await execFileAsync(shellPath, shellArgs);
    const resolvedPath = String(response.stdout || "").trim().split(/\r?\n/)[0] || "";
    if (!resolvedPath) {
      return "";
    }

    if (await isExecutableFile(resolvedPath)) {
      return resolvedPath;
    }
  } catch {
  }

  return "";
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getFileActivityTimestamp(stats) {
  return Math.max(stats.mtimeMs || 0, stats.ctimeMs || 0, stats.birthtimeMs || 0);
}

async function listRecentFiles(directoryPath, extensions, lookbackMinutes) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];
  const now = Date.now();
  const lookbackMs = Math.max(1, Number(lookbackMinutes) || 120) * 60 * 1000;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = path.join(directoryPath, entry.name);
    const extension = path.extname(entry.name).slice(1).toLowerCase();
    if (!extensions.has(extension)) {
      continue;
    }

    try {
      const stats = await fs.stat(fullPath);
      const activityAt = getFileActivityTimestamp(stats);
      if (now - activityAt > lookbackMs) {
        continue;
      }

      files.push({
        path: fullPath,
        name: entry.name,
        modifiedAt: activityAt
      });
    } catch (error) {
      console.warn(`Failed to stat recent file: ${fullPath}`, error);
    }
  }

  return files.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function listSupportedFiles(directoryPath, extensions) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = path.join(directoryPath, entry.name);
    const extension = path.extname(entry.name).slice(1).toLowerCase();
    if (!extensions.has(extension)) {
      continue;
    }

    try {
      const stats = await fs.stat(fullPath);
      const modifiedAt = getFileActivityTimestamp(stats);
      files.push({
        path: fullPath,
        name: entry.name,
        modifiedAt
      });
    } catch (error) {
      console.warn(`Failed to stat supported file: ${fullPath}`, error);
    }
  }

  return files.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function listSupportedFilesRecursive(directoryPath, extensions, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 200;
  const pending = [{ directoryPath, depth: 0 }];
  const files = [];

  while (pending.length && files.length < maxFiles) {
    const current = pending.shift();
    if (!current) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      console.warn(`Failed to scan directory: ${current.directoryPath}`, error);
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }

      const fullPath = path.join(current.directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (/^\./.test(entry.name) || /\.(app|pkg|framework|plugin|bundle)$/i.test(entry.name)) {
          continue;
        }
        if (current.depth < maxDepth) {
          pending.push({ directoryPath: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).slice(1).toLowerCase();
      if (!extensions.has(extension)) {
        continue;
      }

      try {
        const stats = await fs.stat(fullPath);
        const modifiedAt = getFileActivityTimestamp(stats);
        files.push({
          path: fullPath,
          name: entry.name,
          modifiedAt
        });
      } catch (error) {
        console.warn(`Failed to stat supported file: ${fullPath}`, error);
      }
    }
  }

  return files.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function extractPathsFromText(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      if (line.startsWith("file://")) {
        try {
          return decodeURIComponent(line.replace(/^file:\/\//, ""));
        } catch {
          return line.replace(/^file:\/\//, "");
        }
      }
      return line;
    })
    .filter((line) => path.isAbsolute(line));
}

function normalizePossibleFilePath(rawValue) {
  const value = String(rawValue || "").trim().replace(/\u0000/g, "");
  if (!value) {
    return "";
  }

  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(value.replace(/^file:\/\//, ""));
    } catch {
      return value.replace(/^file:\/\//, "");
    }
  }

  return path.isAbsolute(value) ? value : "";
}

function getFilePathFromFileLike(file) {
  if (!file) {
    return "";
  }

  if (typeof file.path === "string" && file.path) {
    return file.path;
  }

  try {
    const electron = require("electron");
    if (electron && electron.webUtils && typeof electron.webUtils.getPathForFile === "function") {
      return electron.webUtils.getPathForFile(file) || "";
    }

    if (
      electron &&
      electron.remote &&
      electron.remote.webUtils &&
      typeof electron.remote.webUtils.getPathForFile === "function"
    ) {
      return electron.remote.webUtils.getPathForFile(file) || "";
    }
  } catch (error) {
    console.warn("Failed to resolve native file path from File object", error);
  }

  return "";
}

async function collectImportablePaths(filePaths, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const maxFilesPerDirectory = Number.isInteger(options.maxFilesPerDirectory) ? options.maxFilesPerDirectory : 50;
  const importable = [];

  for (const rawPath of uniqueStrings(filePaths)) {
    const filePath = normalizePossibleFilePath(rawPath);
    if (!filePath) {
      continue;
    }

    let stats = null;
    try {
      stats = await fs.stat(filePath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      const nested = await listSupportedFilesRecursive(filePath, SUPPORTED_EXTENSIONS, {
        maxDepth,
        maxFiles: maxFilesPerDirectory
      });
      importable.push(...nested.map((item) => item.path));
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    const extension = path.extname(filePath).slice(1).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(extension)) {
      importable.push(filePath);
    }
  }

  return uniqueStrings(importable);
}

async function listAllFilesRecursive(directoryPath, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 100;
  const pending = [{ directoryPath, depth: 0 }];
  const discovered = [];

  while (pending.length && discovered.length < maxFiles) {
    const current = pending.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current.directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          pending.push({ directoryPath: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isFile()) {
        discovered.push(fullPath);
        if (discovered.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return discovered;
}

async function collectDiscoveredFileEntries(filePaths, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 3;
  const maxFilesPerDirectory = Number.isInteger(options.maxFilesPerDirectory) ? options.maxFilesPerDirectory : 100;
  const discovered = [];

  for (const rawPath of uniqueStrings(filePaths)) {
    const filePath = normalizePossibleFilePath(rawPath);
    if (!filePath) {
      continue;
    }

    let stats = null;
    try {
      stats = await fs.stat(filePath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      const nestedPaths = await listAllFilesRecursive(filePath, {
        maxDepth,
        maxFiles: maxFilesPerDirectory
      });
      nestedPaths.forEach((nestedPath) => {
        const baseName = path.basename(nestedPath);
        const extension = path.extname(nestedPath).slice(1).toLowerCase();
        if (baseName.startsWith(".")) {
          return;
        }
        if (!SUPPORTED_EXTENSIONS.has(extension) && !DISCOVERABLE_FALLBACK_EXTENSIONS.has(extension)) {
          return;
        }
        discovered.push({
          path: nestedPath,
          extension,
          supported: SUPPORTED_EXTENSIONS.has(extension)
        });
      });
      continue;
    }

    if (stats.isFile()) {
      if (path.basename(filePath).startsWith(".")) {
        continue;
      }
      const extension = path.extname(filePath).slice(1).toLowerCase();
      discovered.push({
        path: filePath,
        extension,
        supported: SUPPORTED_EXTENSIONS.has(extension)
      });
    }
  }

  const seen = new Set();
  return discovered.filter((entry) => {
    const normalized = normalizePossibleFilePath(entry.path);
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

async function collectExistingLocalPaths(filePaths) {
  const existing = [];

  for (const rawPath of uniqueStrings(filePaths)) {
    const filePath = normalizePossibleFilePath(rawPath);
    if (!filePath) {
      continue;
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.isFile() || stats.isDirectory()) {
        existing.push(filePath);
      }
    } catch {
      continue;
    }
  }

  return uniqueStrings(existing);
}

async function getDroppedPaths(dataTransfer) {
  const paths = [];

  const files = Array.from((dataTransfer && dataTransfer.files) || []);
  files.forEach((file) => {
    const resolvedPath = getFilePathFromFileLike(file);
    if (resolvedPath) {
      paths.push(resolvedPath);
    }
  });

  const items = Array.from((dataTransfer && dataTransfer.items) || []);
  for (const item of items) {
    if (typeof item.getAsFile === "function") {
      const file = item.getAsFile();
      const resolvedPath = getFilePathFromFileLike(file);
      if (resolvedPath) {
        paths.push(resolvedPath);
      }
    }

    if (typeof item.webkitGetAsEntry === "function") {
      const entry = item.webkitGetAsEntry();
      if (entry && typeof entry.fullPath === "string" && path.isAbsolute(entry.fullPath)) {
        paths.push(entry.fullPath);
      }
    }
  }

  if (dataTransfer && typeof dataTransfer.getData === "function") {
    paths.push(...extractPathsFromText(dataTransfer.getData("text/uri-list")));
    paths.push(...extractPathsFromText(dataTransfer.getData("text/plain")));
  }

  const discovered = await collectDiscoveredFileEntries(paths, {
    maxDepth: 4,
    maxFilesPerDirectory: 100
  });
  return discovered.map((entry) => entry.path);
}

function looksLikeClipboardFileName(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value || /[\r\n]/.test(value)) {
    return false;
  }

  return /^[^/\\]+?\.[A-Za-z0-9]{1,12}$/.test(value);
}

function extractClipboardTextValue(dataTransfer) {
  if (!dataTransfer || typeof dataTransfer.getData !== "function") {
    return "";
  }

  return String(dataTransfer.getData("text/plain") || "").trim();
}

function looksLikeOnlyFileReferences(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return false;
  }

  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return false;
  }

  const extractedPaths = extractPathsFromText(value);
  return extractedPaths.length === lines.length;
}

function extractPathsFromArbitraryText(rawValue) {
  const value = String(rawValue || "").replace(/\u0000/g, "\n");
  if (!value.trim()) {
    return [];
  }

  const direct = extractPathsFromText(value);
  if (direct.length) {
    return direct;
  }

  const matches = value.match(/\/Users\/[^\s"'<>]+/g) || [];
  return uniqueStrings(matches);
}

function collectStringsFromJsonValue(input, output = []) {
  if (typeof input === "string") {
    output.push(input);
    return output;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => collectStringsFromJsonValue(item, output));
    return output;
  }

  if (input && typeof input === "object") {
    Object.values(input).forEach((value) => collectStringsFromJsonValue(value, output));
  }

  return output;
}

async function extractPathsFromClipboardBuffer(buffer) {
  if (!buffer || !buffer.length) {
    return [];
  }

  const candidates = [];
  const textCandidates = [
    buffer.toString("utf8"),
    buffer.toString("utf16le")
  ];
  textCandidates.forEach((value) => {
    candidates.push(...extractPathsFromArbitraryText(value));
  });

  const tempPath = path.join(os.tmpdir(), `smart-import-clipboard-${Date.now()}-${Math.random().toString(36).slice(2)}.plist`);
  try {
    await fs.writeFile(tempPath, buffer);
    const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", tempPath]);
    const parsed = JSON.parse(stdout);
    const strings = collectStringsFromJsonValue(parsed);
    strings.forEach((value) => {
      candidates.push(...extractPathsFromArbitraryText(value));
    });
  } catch {
    // Ignore non-plist clipboard payloads.
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }

  return uniqueStrings(candidates);
}

async function findLocalFilePathsByName(fileName) {
  const normalizedName = String(fileName || "").trim();
  if (!normalizedName || !looksLikeClipboardFileName(normalizedName) || process.platform !== "darwin") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/mdfind", ["-name", normalizedName]);
    const matches = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((candidate) => path.basename(candidate) === normalizedName);
    const existing = await collectExistingLocalPaths(matches.slice(0, 20));
    const withStats = await Promise.all(existing.map(async (candidate) => {
      try {
        const stats = await fs.stat(candidate);
        return {
          path: candidate,
          modifiedAt: getFileActivityTimestamp(stats)
        };
      } catch {
        return null;
      }
    }));
    return withStats
      .filter(Boolean)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map((item) => item.path)
      .slice(0, 1);
  } catch (error) {
    console.warn("Failed to locate clipboard file by name", error);
    return [];
  }
}

async function ensureFolder(app, folderPath) {
  const normalized = normalizePath(folderPath);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.createFolder(current);
    }
  }
}

async function listVaultBusinessFilesRecursive(baseDirectory, relativeDirectory = "") {
  const absoluteDirectory = relativeDirectory ? path.join(baseDirectory, relativeDirectory) : baseDirectory;
  let entries = [];
  try {
    entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const nextRelativePath = normalizePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
    if (isInternalActivityPath(nextRelativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await listVaultBusinessFilesRecursive(baseDirectory, nextRelativePath)));
      continue;
    }

    if (!entry.isFile() || !isTrackedActivityPath(nextRelativePath)) {
      continue;
    }

    results.push(nextRelativePath);
  }

  return results;
}

async function getUniqueVaultPath(app, desiredPath, options = {}) {
  const normalized = normalizePath(desiredPath);
  const extension = path.extname(normalized);
  const directory = path.posix.dirname(normalized);
  const baseName = path.basename(normalized, extension);
  const separator = options.separator || "-";
  let attempt = normalized;
  let index = options.startAt || 2;

  while (await app.vault.adapter.exists(attempt)) {
    const numberedBase = `${baseName}${separator}${index}`;
    attempt = normalizePath(
      directory === "." ? `${numberedBase}${extension}` : `${directory}/${numberedBase}${extension}`
    );
    index += 1;
  }

  return attempt;
}

const IMPORT_FRONTMATTER_ORDER = [
  "source_file_name",
  "source_type",
  "imported_at",
  "import_method",
  "conversion_status",
  "original_file",
  "import_record",
  "converter_name"
];

function mapImportStatusToConversionStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "partial_success") {
    return "partial";
  }
  if (normalized === "failed") {
    return "failed";
  }
  return "success";
}

function splitFrontmatter(content) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match) {
    return {
      frontmatter: "",
      body: text
    };
  }

  return {
    frontmatter: match[1],
    body: text.slice(match[0].length)
  };
}

function mergeFrontmatterFields(content, nextFields) {
  const { frontmatter, body } = splitFrontmatter(content);
  const fieldMap = new Map();
  const passthrough = [];
  const lines = frontmatter ? frontmatter.split("\n") : [];

  lines.forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      fieldMap.set(match[1], match[2]);
      return;
    }
    if (line.trim()) {
      passthrough.push(line);
    }
  });

  Object.entries(nextFields || {}).forEach(([key, value]) => {
    if (value == null || value === "") {
      fieldMap.delete(key);
      return;
    }
    fieldMap.set(key, yamlString(value));
  });

  const rendered = [];
  IMPORT_FRONTMATTER_ORDER.forEach((key) => {
    if (fieldMap.has(key)) {
      rendered.push(`${key}: ${fieldMap.get(key)}`);
      fieldMap.delete(key);
    }
  });

  passthrough.forEach((line) => {
    rendered.push(line);
  });

  for (const [key, value] of fieldMap.entries()) {
    rendered.push(`${key}: ${value}`);
  }

  return `---\n${rendered.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`.replace(/\n{3,}/g, "\n\n");
}

function buildImportedFrontmatterFields(context) {
  return {
    source_file_name: context.sourceFileName || "",
    source_type: context.sourceFileType || "",
    imported_at: context.importedAt || "",
    import_method: context.importMethod || "",
    conversion_status: mapImportStatusToConversionStatus(context.status),
    original_file: context.sourceFileStoredPath || "",
    import_record: context.importRecordPath || "",
    converter_name: context.converterName || ""
  };
}

function replaceMarkdownSection(content, heading, nextBody) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const sectionPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*\\n+[\\s\\S]*?(?=^##\\s+|$)`, "gm");
  if (nextBody == null || !String(nextBody).trim()) {
    return text.replace(sectionPattern, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  const rendered = `## ${heading}\n\n${String(nextBody).trim()}\n`;
  if (sectionPattern.test(text)) {
    let replaced = false;
    return text
      .replace(sectionPattern, () => {
        if (replaced) {
          return "";
        }
        replaced = true;
        return rendered;
      })
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n";
  }
  return `${text.replace(/\s+$/, "")}\n\n${rendered}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function buildOriginalFileSectionContent(context) {
  if (context.sourceFileStoredPath) {
    return `- Vault 原件：\`${context.sourceFileStoredPath}\``;
  }
  if (context.sourceFilePath && !String(context.sourceFilePath).startsWith("clipboard://")) {
    return `- 外部原件：\`${context.sourceFilePath}\``;
  }
  return "";
}

function buildWarningSectionContent(context) {
  const warnings = uniqueStrings([
    context.warning || "",
    context.manualNextStep || ""
  ]);
  return warnings.join("\n- ").trim() ? `- ${warnings.join("\n- ")}` : "";
}

function buildMarkdownDocument(context) {
  const cleanedContent = cleanImportedContent(context.content, context.title, context.sourceFileName);
  const body = [];
  const title = cleanDisplayName(context.title || path.basename(context.outputNotePath || "", path.extname(context.outputNotePath || "")) || "导入文件");
  const importedAtText = formatImportedAtLine(context.importedAt);
  const warningSection = buildWarningSectionContent(context);
  const originalFileSection = buildOriginalFileSectionContent(context);

  body.push(`# ${title}`, "");
  body.push(`> Imported from \`${context.sourceFileName || "未知来源"}\` on ${importedAtText}.`, "");

  if (cleanedContent) {
    body.push("## Content", "", cleanedContent.trim(), "");
  }

  if (warningSection) {
    body.push("## Warnings", "", warningSection, "");
  }

  if (originalFileSection) {
    body.push("## Original File", "", originalFileSection, "");
  }

  if (!cleanedContent && !warningSection) {
    body.push("导入后暂未生成可显示的正文内容。", "");
  }

  return mergeFrontmatterFields(
    `${body.join("\n")}`.trimEnd() + "\n",
    buildImportedFrontmatterFields(context)
  );
}

function isLikelyLowQualityPdfMarkdown(content) {
  const text = String(content || "").trim();
  if (!text) {
    return true;
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 240) {
    return true;
  }

  const meaningfulChars = (normalized.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || []).length;
  const ratio = meaningfulChars / Math.max(normalized.length, 1);
  return ratio < 0.45;
}

function cleanOcrMarkdown(content) {
  const text = String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/([A-Za-z])-\n([A-Za-z])/g, "$1$2")
    .replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/\s+([，。！？；：])/g, "$1")
    .trim();

  const rawLines = text.split("\n");
  const normalizedLines = rawLines.map((raw) =>
    raw
      .trim()
      .replace(/^\|\s+/, "> ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^([一二三四五六七八九十0-9]+)\s+([、.)）])/u, "$1$2")
  );
  const merged = [];
  const seenHeadings = new Set();

  const isBlank = (line) => !String(line || "").trim();
  const isPageMarker = (line) => /^##\s+第\s+\d+\s+页$/.test(line);
  const isDisposablePageNoise = (line) => /^(第\s*\d+\s*页|\d+\s*\/\s*\d+)$/.test(line);
  const isShortHeading = (line) =>
    /^[\u4e00-\u9fffA-Za-z0-9 ]{1,16}$/.test(line) &&
    /[\u4e00-\u9fffA-Za-z]/.test(line) &&
    !/^(待验证|结果|项目|说明)$/.test(line);
  const isListLike = (line) =>
    /^(#|>|- |\* |\d+\. |\d+[、.)）])/.test(line) ||
    (line.length >= 8 && line.length <= 32 && /[A-Za-z0-9\u4e00-\u9fff]/.test(line));
  const isTableCandidate = (line) =>
    !line.startsWith("|") &&
    !line.startsWith(">") &&
    !line.startsWith("#") &&
    /[\u4e00-\u9fffA-Za-z0-9]/.test(line) &&
    /["']/.test(line);
  const normalizeComparableLine = (line) =>
    String(line || "")
      .replace(/^#+\s*/, "")
      .replace(/\s+/g, "")
      .replace(/["']/g, "")
      .toLowerCase();
  const canAppendToParagraph = (line) => {
    if (!line) return false;
    if (/^(#|>|- |\* |\d+\. |\|)/.test(line)) return false;
    if (line.length <= 18) return false;
    if (/[。！？：.!?;:]$/.test(line)) return false;
    return true;
  };

  for (let index = 0; index < normalizedLines.length; index += 1) {
    let line = normalizedLines[index];
    const previousRaw = index > 0 ? normalizedLines[index - 1] : "";
    const nextRaw = index + 1 < normalizedLines.length ? normalizedLines[index + 1] : "";

    if (isBlank(line)) {
      if (merged.length && merged[merged.length - 1] !== "") {
        merged.push("");
      }
      continue;
    }

    if (isDisposablePageNoise(line)) {
      continue;
    }

    if (/^第\s+\d+\s+页$/.test(line)) {
      merged.push(`## ${line}`);
      merged.push("");
      continue;
    }

    if (isPageMarker(line)) {
      merged.push(line);
      merged.push("");
      continue;
    }

    if (isTableCandidate(line)) {
      const columns = line
        .split(/\s{1,}/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (columns.length >= 3 && columns.length <= 5) {
        line = `| ${columns.join(" | ")} |`;
      }
    }

    if (isShortHeading(line) && isBlank(previousRaw) && isBlank(nextRaw)) {
      const normalizedHeading = line.replace(/\s+/g, "").toLowerCase();
      if (!seenHeadings.has(normalizedHeading)) {
        seenHeadings.add(normalizedHeading);
        merged.push(`## ${line}`);
        merged.push("");
      }
      if (normalizeComparableLine(nextRaw) === normalizedHeading) {
        index += 1;
      }
      continue;
    }

    if (
      isShortHeading(line) &&
      isBlank(previousRaw) &&
      nextRaw &&
      !isBlank(nextRaw) &&
      nextRaw.length <= 32 &&
      !/^(#|>|- |\* |\d+\. |\|)/.test(nextRaw)
    ) {
      const normalizedHeading = line.replace(/\s+/g, "").toLowerCase();
      if (!seenHeadings.has(normalizedHeading)) {
        seenHeadings.add(normalizedHeading);
        merged.push(`## ${line}`);
      }
      if (normalizeComparableLine(nextRaw) === normalizedHeading) {
        index += 1;
      }
      continue;
    }

    const previous = merged.length ? merged[merged.length - 1] : "";
    if (
      previous &&
      canAppendToParagraph(previous) &&
      !isBlank(line) &&
      !isListLike(line) &&
      !isTableCandidate(line)
    ) {
      const joiner = /[\u4e00-\u9fff]$/.test(previous) && /^[\u4e00-\u9fff]/.test(line) ? "" : " ";
      merged[merged.length - 1] = `${previous}${joiner}${line}`;
      continue;
    }

    if (
      merged.length &&
      /^##\s+/.test(merged[merged.length - 1]) &&
      !/^(#|>|- |\* |\d+\. |\|)/.test(line) &&
      line.length >= 8 &&
      line.length <= 28 &&
      /[。！？.!?]$/.test(line) === false &&
      /[\u4e00-\u9fffA-Za-z0-9]/.test(line)
    ) {
      line = `- ${line}`;
    }

    merged.push(line);
  }

  return merged.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function buildOcrCorrectionMessages(markdown) {
  return [
    {
      role: "system",
      content:
        "你是 OCR 文本清洗助手。请修正明显 OCR 错字、乱码、断行和标点问题，但不要凭空补充事实。必须输出纯 Markdown 正文，不要解释。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "修正 OCR 生成的 Markdown 文本",
        constraints: [
          "保留现有标题、列表、表格和页结构",
          "优先修正常见 OCR 错字、错标点、断句和中英混排空格",
          "不要编造不存在的内容",
          "只输出修正后的 Markdown"
        ],
        markdown
      })
    }
  ];
}

function buildMarkdownCleanupMessages(title, markdown) {
  return [
    {
      role: "system",
      content:
        "你是 Markdown 整理助手。请把半结构化草稿整理成可读的 Markdown 文档。保留原意，不要编造内容，只输出整理后的 Markdown。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "整理 Markdown 文档结构",
        constraints: [
          "保留事实内容，不要补充不存在的信息",
          "优先整理标题层级、列表、分隔线、表格样式和段落空行",
          "去掉重复标题和明显的脏分隔符",
          "如果原文是草稿式的 | 分隔内容，请尽量转成更易读的 Markdown 结构",
          "只输出 Markdown"
        ],
        title,
        markdown
      })
    }
  ];
}

function joinMarkdownParagraphLines(lines) {
  const filtered = (lines || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (!filtered.length) {
    return "";
  }

  let current = filtered[0];
  for (let index = 1; index < filtered.length; index += 1) {
    const line = filtered[index];
    const joiner = /[\u4e00-\u9fff]$/.test(current) && /^[\u4e00-\u9fff]/.test(line) ? "" : " ";
    current += `${joiner}${line}`;
  }
  return current;
}

function formatImportedMarkdownLocally(title, content) {
  const source = repairBrokenMarkdownTables(
    String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  );

  if (!source) {
    return "";
  }

  const normalizedTitle = normalizeComparableTitle(title);
  const rawLines = source.split("\n");
  const lines = [];

  for (const rawLine of rawLines) {
    let line = rawLine
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/[—–]/g, "-")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    if (!line) {
      lines.push("");
      continue;
    }

    if (normalizeComparableTitle(line.replace(/^#+\s*/, "")) === normalizedTitle && !lines.length) {
      continue;
    }

    lines.push(line);
  }

  const output = [];
  let paragraphBuffer = [];
  let inCodeFence = false;

  const flushParagraph = () => {
    const paragraph = joinMarkdownParagraphLines(paragraphBuffer);
    if (paragraph) {
      output.push(paragraph);
    }
    paragraphBuffer = [];
  };

  const pushBlock = (line = "") => {
    if (!line) {
      flushParagraph();
      if (output.length && output[output.length - 1] !== "") {
        output.push("");
      }
      return;
    }

    flushParagraph();
    if (/^(#{1,6}\s|---$)/.test(line) && output.length && output[output.length - 1] !== "") {
      output.push("");
    }
    output.push(line);
    if (/^#{1,6}\s/.test(line)) {
      output.push("");
    }
  };

  const parsePipeSegments = (line) =>
    line
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      output.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      output.push(line);
      continue;
    }

    if (!line) {
      pushBlock("");
      continue;
    }

    if (isMarkdownTableSeparator(line)) {
      pushBlock(buildMarkdownTableRow(parseMarkdownTableCells(line)));
      continue;
    }

    if (/^\|?(-\|){3,}-?$/.test(line) || /^[|\-]{6,}$/.test(line)) {
      pushBlock("---");
      continue;
    }

    if (/^\*+\|/.test(line)) {
      const cleaned = line.replace(/^\*+/, "").replace(/\*+$/, "").trim();
      const parts = parsePipeSegments(cleaned);
      if (parts.length >= 2) {
        pushBlock(`## ${parts[0]}`);
        const detail = parts.slice(1).join(" / ");
        if (detail) {
          output.push(`- ${detail}`);
        }
        continue;
      }
    }

    if (/^\|{3,}.+\|{3,}$/.test(line)) {
      const inner = line.replace(/^\|+/, "").replace(/\|+$/, "").trim();
      const parts = parsePipeSegments(inner);
      if (parts.length) {
        pushBlock(`## ${parts[0]}`);
        const detail = parts.slice(1).join(" / ");
        if (detail) {
          output.push(`- ${detail}`);
        }
        continue;
      }
    }

    if (line.startsWith("|")) {
      const tableCells = parseMarkdownTableCells(line);
      if (tableCells.length >= 2) {
        pushBlock(buildMarkdownTableRow(tableCells));
        continue;
      }
    }

    const pipeParts = parsePipeSegments(line);
    if (pipeParts.length >= 2 && !line.startsWith("|")) {
      if (pipeParts.length === 2) {
        output.push(`- **${pipeParts[0]}**：${pipeParts[1]}`);
      } else {
        output.push(`- ${pipeParts.join(" / ")}`);
      }
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+[.)、]\s*/.test(line) || /^>\s*/.test(line) || /^#{1,6}\s+/.test(line)) {
      pushBlock(line);
      continue;
    }

    if (
      line.length <= 28 &&
      !/[。！？.!?：:]$/.test(line) &&
      /[\u4e00-\u9fffA-Za-z]/.test(line)
    ) {
      pushBlock(`## ${line}`);
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();

  const cleanedOutput = [];
  let previousNonEmptyHeading = "";
  for (const item of output) {
    const line = String(item || "");
    if (!line) {
      if (cleanedOutput.length && cleanedOutput[cleanedOutput.length - 1] !== "") {
        cleanedOutput.push("");
      }
      continue;
    }

    if (/^##\s+/.test(line)) {
      const normalizedHeading = normalizeComparableTitle(line.replace(/^##\s+/, ""));
      if (normalizedHeading && normalizedHeading === previousNonEmptyHeading) {
        continue;
      }
      previousNonEmptyHeading = normalizedHeading;
    }

    cleanedOutput.push(line);
  }

  return cleanedOutput.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function buildImportRecord(context) {
  return JSON.stringify(
    {
      id: context.id,
      source_file_original_name: context.sourceFileOriginalName,
      source_file_path: context.sourceFilePath,
      source_file_stored_path: context.sourceFileStoredPath,
      output_note_path: context.outputNotePath,
      output_assets_path: context.outputAssetsPath,
      import_record_path: context.importRecordPath,
      source_type: context.sourceType,
      status: context.status,
      import_status: context.status,
      imported_at: context.importedAt,
      import_method: context.importMethod,
      converter_name: context.converterName,
      converter_version: context.converterVersion || "",
      original_file_retained: Boolean(context.sourceFileStoredPath),
      warning: context.warning || "",
      preview_text: context.previewText || "",
      ai_summary: context.aiSummary || "",
      ai_tags_suggestion: Array.isArray(context.aiTagsSuggestion) ? context.aiTagsSuggestion : [],
      ai_failure_explanation: context.aiFailureExplanation || "",
      ai_next_actions: Array.isArray(context.aiNextActions) ? context.aiNextActions : [],
      ai_suggested_folder: context.aiSuggestedFolder || "",
      ai_suggested_title: context.aiSuggestedTitle || "",
      ai_provider_used: context.aiProviderUsed || "",
      quality_score: context.qualityScore == null ? null : context.qualityScore
    },
    null,
    2
  ) + "\n";
}

function getStatusMeta(status) {
  return STATUS_META[status] || { label: status || "Unknown", tone: "neutral" };
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function getPlatformLabel(platform = process.platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform || "未知平台";
}

function formatImportedAt(value) {
  if (!value) {
    return "未知时间";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatImportedAtLine(value) {
  if (!value) {
    return "未知时间";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mm = String(parsed.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hh}:${mm}`;
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHtmlEntities(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  if (typeof document !== "undefined" && document.createElement) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractHtmlTagContent(html, tagName) {
  const match = String(html || "").match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return decodeHtmlEntities(match ? match[1].replace(/\s+/g, " ").trim() : "");
}

function extractHtmlMetaContent(html, attribute, key) {
  const pattern = new RegExp(
    `<meta[^>]+${attribute}=["']${escapeRegExp(key)}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
    "i"
  );
  const reversedPattern = new RegExp(
    `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+${attribute}=["']${escapeRegExp(key)}["'][^>]*>`,
    "i"
  );
  const match = String(html || "").match(pattern) || String(html || "").match(reversedPattern);
  return decodeHtmlEntities(match ? match[1].replace(/\s+/g, " ").trim() : "");
}

function extractReadableHtmlSnippet(html, maxLength = 480) {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(cleaned)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeComparableTitle(value) {
  return String(value || "")
    .trim()
    .replace(/\.(doc|docx|pdf|pptx|txt|md|epub|mobi|azw3)$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function cleanImportedContent(content, title, sourceFileName) {
  const raw = String(content || "").trim();
  const trimmed = splitFrontmatter(raw).body.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split(/\r?\n/);
  const firstLine = (lines[0] || "").trim();
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (!headingMatch) {
    return trimmed;
  }

  const headingTitle = normalizeComparableTitle(headingMatch[1]);
  const noteTitle = normalizeComparableTitle(title);
  const sourceTitle = normalizeComparableTitle(sourceFileName);
  if (headingTitle !== noteTitle && headingTitle !== sourceTitle) {
    return lines.slice(1).join("\n").replace(/^\s+/, "").trim();
  }

  return lines.slice(1).join("\n").replace(/^\s+/, "").trim();
}

function isMarkdownTableSeparator(line) {
  return /^\|\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(String(line || "").trim());
}

function parseMarkdownTableCells(line, expectedColumns = 0) {
  const parts = String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => String(cell || "").trim());

  if (expectedColumns > 0 && parts.length > expectedColumns) {
    const next = parts.slice(0, Math.max(expectedColumns - 1, 1));
    next.push(parts.slice(Math.max(expectedColumns - 1, 1)).join(" | "));
    return next;
  }

  return parts;
}

function normalizeSpreadsheetCell(cell) {
  const value = String(cell || "").trim();
  if (!value || /^NaN$/i.test(value) || /^Unnamed:\s*\d+$/i.test(value)) {
    return "";
  }

  const normalized = value
    .replace(/\\n/g, "<br>")
    .replace(/\s*<br>\s*/g, "<br>")
    .trim();

  if (normalized.includes("|") && normalized.includes("<br>")) {
    const parts = normalized
      .split("<br>")
      .map((line) => line.replace(/^\|+/, "").replace(/\|+$/, "").trim())
      .map((line) => line.split("|").map((item) => item.trim()).filter(Boolean))
      .filter((items) => items.length);

    if (parts.length) {
      return parts
        .map((items) => (items.length === 1 ? items[0] : items.join(" / ")))
        .join("<br>");
    }
  }

  return normalized;
}

function trimSpreadsheetRows(rows) {
  let maxWidth = 0;
  rows.forEach((row) => {
    let lastNonEmpty = -1;
    row.forEach((cell, index) => {
      if (String(cell || "").trim()) {
        lastNonEmpty = index;
      }
    });
    maxWidth = Math.max(maxWidth, lastNonEmpty + 1);
  });

  const width = Math.max(maxWidth, 1);
  return rows.map((row) => {
    const trimmed = row.slice(0, width);
    while (trimmed.length < width) {
      trimmed.push("");
    }
    return trimmed;
  });
}

function isSpreadsheetHeaderCandidate(cells) {
  const nonEmpty = (cells || []).map((cell) => String(cell || "").trim()).filter(Boolean);
  if (nonEmpty.length < 3) {
    return false;
  }

  if (nonEmpty.some((cell) => /^https?:\/\//i.test(cell) || /@/.test(cell))) {
    return false;
  }

  const shortCells = nonEmpty.filter((cell) => cell.length <= 24).length;
  return shortCells >= Math.ceil(nonEmpty.length * 0.6);
}

function formatSpreadsheetMetaRows(rows) {
  const lines = [];

  rows.forEach((row) => {
    const nonEmpty = row.map((cell) => String(cell || "").trim()).filter(Boolean);
    if (!nonEmpty.length) {
      return;
    }

    if (nonEmpty.length === 1) {
      lines.push(`**${nonEmpty[0]}**`);
      return;
    }

    if (nonEmpty.length === 2) {
      lines.push(`- **${nonEmpty[0]}**：${nonEmpty[1]}`);
      return;
    }

    if (nonEmpty.length % 2 === 0) {
      const pairs = [];
      for (let index = 0; index < nonEmpty.length; index += 2) {
        const left = nonEmpty[index];
        const right = nonEmpty[index + 1];
        if (!left || !right) {
          continue;
        }
        pairs.push(`**${left}**：${right}`);
      }
      if (pairs.length) {
        lines.push(`- ${pairs.join("；")}`);
        return;
      }
    }

    lines.push(`- ${nonEmpty.join(" / ")}`);
  });

  return lines;
}

function isSpreadsheetKeyValueRows(rows) {
  const meaningful = (rows || []).filter((row) => row.some((cell) => String(cell || "").trim()));
  if (!meaningful.length) {
    return false;
  }

  const narrowRows = meaningful.filter((row) => row.filter((cell) => String(cell || "").trim()).length <= 2);
  return narrowRows.length === meaningful.length;
}

function buildMarkdownTableRow(cells) {
  return `| ${cells.map((cell) => String(cell || "").replace(/\|/g, "\\|")).join(" | ")} |`;
}

function countMarkdownTablePipes(line) {
  return (String(line || "").match(/\|/g) || []).length;
}

function isCompleteMarkdownTableRow(line, expectedColumns) {
  const text = String(line || "").trim();
  return text.startsWith("|") && text.endsWith("|") && countMarkdownTablePipes(text) >= expectedColumns + 1;
}

function normalizeBrokenMarkdownTableCell(cell) {
  const value = String(cell || "")
    .replace(/\s*<br>\s*/g, "<br>")
    .replace(/<br>{3,}/g, "<br><br>")
    .trim();

  if (!value) {
    return "";
  }

  if (/^\*\*[\s\S]+\*\*$/.test(value)) {
    const inner = value
      .slice(2, -2)
      .replace(/<br>/g, " / ")
      .replace(/\s+\/\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return `**${inner}**`;
  }

  return value
    .replace(/\*\*<br>\*\*/g, "**")
    .replace(/<br>\*\*$/g, "**")
    .replace(/^\*\*<br>/g, "**")
    .trim();
}

function normalizeBrokenMarkdownTableRow(rawRow, expectedColumns) {
  const cells = parseMarkdownTableCells(rawRow, expectedColumns)
    .map((cell) => normalizeBrokenMarkdownTableCell(cell));
  const normalizedCells = cells.slice(0, expectedColumns);
  while (normalizedCells.length < expectedColumns) {
    normalizedCells.push("");
  }
  return buildMarkdownTableRow(normalizedCells);
}

function repairBrokenMarkdownTables(content) {
  const source = String(content || "").replace(/\r\n/g, "\n");
  if (!source.includes("\n|") || !source.includes("\n|-")) {
    return source;
  }

  const lines = source.split("\n");
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || "");
    const nextLine = String(index + 1 < lines.length ? lines[index + 1] : "");

    if (line.trim().startsWith("|") && isMarkdownTableSeparator(nextLine)) {
      const headerCells = parseMarkdownTableCells(line);
      const expectedColumns = headerCells.length;
      output.push(buildMarkdownTableRow(headerCells));
      output.push(buildMarkdownTableRow(headerCells.map(() => "---")));

      let cursor = index + 2;
      let currentRow = "";

      while (cursor < lines.length) {
        const rawLine = String(lines[cursor] || "");
        const trimmedLine = rawLine.trim();

        if (!currentRow) {
          if (!trimmedLine) {
            cursor += 1;
            continue;
          }

          if (!trimmedLine.startsWith("|")) {
            break;
          }

          currentRow = trimmedLine;
          cursor += 1;
          continue;
        }

        if (isCompleteMarkdownTableRow(currentRow, expectedColumns)) {
          if (!trimmedLine) {
            cursor += 1;
            continue;
          }

          if (trimmedLine.startsWith("|")) {
            output.push(normalizeBrokenMarkdownTableRow(currentRow, expectedColumns));
            currentRow = trimmedLine;
            cursor += 1;
            continue;
          }

          break;
        }

        currentRow += trimmedLine ? `<br>${trimmedLine}` : "<br>";
        cursor += 1;
      }

      if (currentRow) {
        output.push(normalizeBrokenMarkdownTableRow(currentRow, expectedColumns));
      }

      index = cursor - 1;
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function cleanSpreadsheetTableBlock(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return String((lines || []).join("\n") || "").trim();
  }

  const baseWidth = parseMarkdownTableCells(lines[0]).length;
  const headerRow = parseMarkdownTableCells(lines[0], baseWidth).map(normalizeSpreadsheetCell);
  const bodyRows = lines
    .slice(2)
    .map((line) => parseMarkdownTableCells(line, baseWidth).map(normalizeSpreadsheetCell));

  let rows = trimSpreadsheetRows([headerRow, ...bodyRows]).filter((row, index) => {
    if (index === 0) {
      return true;
    }
    return row.some((cell) => String(cell || "").trim());
  });

  if (!rows.length) {
    return "";
  }

  let nextHeader = rows[0];
  let nextBody = rows.slice(1);
  const output = [];

  const headerNonEmptyCount = nextHeader.filter(Boolean).length;
  if (headerNonEmptyCount <= 1) {
    const titleCell = nextHeader.find(Boolean);
    if (titleCell) {
      output.push(`**${titleCell}**`);
    }

    if (isSpreadsheetKeyValueRows(nextBody)) {
      output.push(...formatSpreadsheetMetaRows(nextBody).filter((line) => line !== "- **字段**：值"));
      return output.join("\n").trim();
    }

    const headerIndex = nextBody.findIndex((row) => isSpreadsheetHeaderCandidate(row));
    if (headerIndex >= 0) {
      const leadingRows = nextBody.slice(0, headerIndex);
      output.push(...formatSpreadsheetMetaRows(leadingRows));
      nextHeader = nextBody[headerIndex];
      nextBody = nextBody.slice(headerIndex + 1);
    } else {
      output.push(...formatSpreadsheetMetaRows(nextBody));
      return output.join("\n").trim();
    }
  }

  const cleanedRows = trimSpreadsheetRows([nextHeader, ...nextBody]);
  nextHeader = cleanedRows[0];
  nextBody = cleanedRows.slice(1).filter((row) => row.some((cell) => String(cell || "").trim()));

  if (!nextHeader.some((cell) => String(cell || "").trim())) {
    return output.join("\n").trim();
  }

  if (output.length) {
    output.push("");
  }

  output.push(buildMarkdownTableRow(nextHeader));
  output.push(buildMarkdownTableRow(nextHeader.map(() => "---")));
  nextBody.forEach((row) => {
    output.push(buildMarkdownTableRow(row));
  });

  return output.join("\n").trim();
}

function cleanSpreadsheetMarkdown(content) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = index + 1 < lines.length ? lines[index + 1] : "";

    if (String(line || "").trim().startsWith("|") && isMarkdownTableSeparator(nextLine)) {
      const tableLines = [line, nextLine];
      index += 2;
      while (index < lines.length && String(lines[index] || "").trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;

      const cleanedTable = cleanSpreadsheetTableBlock(tableLines);
      if (cleanedTable) {
        output.push(cleanedTable);
      }
      continue;
    }

    output.push(line.replace(/\bNaN\b/g, "").replace(/Unnamed:\s*\d+/g, "").replace(/[ \t]{2,}/g, " ").trimEnd());
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n(\*\*.+\*\*)\n\|/g, "\n$1\n\n|")
    .trim() + "\n";
}

function extractLegacyImportedPayload(content) {
  const text = String(content || "");
  const frontmatterMatch = text.match(/^---\n([\s\S]*?)\n---\n*/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
  const hasCurrentImportFrontmatter = /(?:^|\n)(source_file_name|conversion_status|import_record):\s*/.test(frontmatter);
  const hasLegacyImportWarning = /(?:^|\n)##\s+Import Warning\s*\n/m.test(text);
  const hasLegacyImportResult = /(?:^|\n)##\s+Import Result\s*\n/m.test(text);
  const hasLegacyContentOnly = /(?:^|\n)##\s+Content\s*\n/m.test(text) && !hasCurrentImportFrontmatter;
  const hasOldFrontmatter = Boolean(frontmatterMatch) && (hasLegacyImportWarning || hasLegacyImportResult || hasLegacyContentOnly);
  const hasHtmlHeader = text.includes('<div class="smart-import-note-header">');
  const hasLegacyFence = text.startsWith("```smart-import-note");
  if (!hasOldFrontmatter && !hasHtmlHeader && !hasLegacyFence) {
    return null;
  }

  if (hasOldFrontmatter) {
    const warningMatch = text.match(/## Import Warning\s*\n+([\s\S]*?)(?=\n##\s+|$)/);
    const contentMatch = text.match(/## Content\s*\n+([\s\S]*?)(?=\n##\s+|$)/);
    if (!warningMatch && !contentMatch) {
      return null;
    }
    return {
      warning: warningMatch ? warningMatch[1].trim() : "",
      content: contentMatch ? contentMatch[1].trim() : ""
    };
  }

  const cleaned = text
    .replace(/^```smart-import-note\n[\s\S]*?\n```\s*/m, "")
    .replace(/^<div class="smart-import-note-header">[\s\S]*?<\/div>\s*/m, "")
    .replace(/^<button class="smart-import-note-header__action"[\s\S]*?<\/div>\s*/m, "")
    .trim();
  return {
    warning: "",
    content: cleaned
  };
}

function getDisplayNameFromRecord(record) {
  return record.fileName || record.file_name || record.source_file_original_name || path.basename(record.filePath || record.output_note_path || "") || "未命名文件";
}

function countMarkdownSectionOccurrences(content, heading) {
  return (String(content || "").match(new RegExp(`(?:^|\\n)##\\s+${escapeRegExp(heading)}\\s*(?=\\n)`, "g")) || []).length;
}

function formatImportMethodLabel(importMethod) {
  const normalized = String(importMethod || "").trim();
  const mapping = {
    "file-picker": "选择文件",
    "drag-drop": "拖拽导入",
    "recent-downloads": "最近下载",
    "finder-selection": "Finder 当前选中",
    "folder-picker": "文件夹导入",
    "smart-request": "自然语言导入",
    "retry": "重试导入",
    "clipboard-paste-text": "剪贴板文本",
    "clipboard-content-url": "网页内容导入",
    "paste-content-modal": "粘贴内容导入",
    "paste-content-modal-file": "粘贴内容文件导入"
  };
  return mapping[normalized] || normalized || "导入";
}

function formatSourceType(sourceType) {
  const normalized = String(sourceType || "").toLowerCase();
  if (normalized === "doc") return "Word";
  if (normalized === "docx") return "Word";
  if (normalized === "xls") return "Excel";
  if (normalized === "xlsx") return "Excel";
  if (normalized === "pdf") return "PDF";
  if (normalized === "pptx") return "PPT";
  if (normalized === "md") return "Markdown";
  if (normalized === "txt") return "文本";
  if (normalized === "epub") return "EPUB";
  if (normalized === "mobi") return "MOBI";
  if (normalized === "azw3") return "AZW3";
  return normalized ? normalized.toUpperCase() : "文件";
}

function detectDocumentType(sourceType, text) {
  const content = `${sourceType || ""}\n${text || ""}`.toLowerCase();
  if (sourceType === "xls" || sourceType === "xlsx" || content.includes("sheet") || content.includes("表格")) {
    return "表格资料";
  }
  if (EBOOK_EXTENSIONS.has(String(sourceType || "").toLowerCase())) return "电子书";
  if (content.includes("合同") || content.includes("协议")) return "合同";
  if (content.includes("预算") || content.includes("报价")) return "预算";
  if (content.includes("汇报") || content.includes("ppt") || content.includes("slide")) return "汇报材料";
  if (content.includes("研究") || content.includes("论文")) return "研究资料";
  if (content.includes("会议") || content.includes("纪要")) return "会议材料";
  return "通用资料";
}

function generateRuleBasedAiSuggestions(record) {
  const actions = [];
  const status = record.import_status || record.status;
  if (status === "failed") {
    actions.push("查看失败原因并重试");
  } else if (record.source_type === "pdf") {
    actions.push("检查 PDF 转换格式是否正确");
  } else if (record.source_type === "pptx") {
    actions.push("确认标题层级和页面结构");
  } else if (record.source_type === "md") {
    actions.push("检查 Markdown 结构并继续整理");
  } else if (record.source_type === "docx") {
    actions.push("整理为正式笔记");
  } else if (EBOOK_EXTENSIONS.has(String(record.source_type || "").toLowerCase())) {
    actions.push("整理章节结构和书摘重点");
  } else if (record.source_type === "xls" || record.source_type === "xlsx") {
    actions.push("检查表格列和工作表结构");
  } else if (record.output_note_path) {
    actions.push("继续整理这份资料");
  }
  actions.push("调整保存位置");
  const tags = uniqueStrings([
    formatSourceType(record.source_type),
    detectDocumentType(record.source_type, record.preview_text || ""),
    getDisplayFolder(record) === "Inbox" ? "待整理" : ""
  ]).map((tag) => `#${tag.replace(/\s+/g, "")}`);

  const summarySource = String(record.preview_text || "").replace(/\s+/g, " ").trim();
  const summary = summarySource
    ? summarySource.slice(0, 120) + (summarySource.length > 120 ? "..." : "")
    : `${formatSourceType(record.source_type)} 已导入，可继续整理。`;

  const suggestedTitle = cleanDisplayName(
    path.basename(record.output_note_path || record.source_file_original_name || "导入文件", path.extname(record.output_note_path || ""))
  );

  return {
    aiSummary: summary,
    aiSuggestedTitle: suggestedTitle,
    aiSuggestedFolder: getDisplayFolder(record) === "Inbox" ? "Inbox" : getDisplayFolder(record),
    aiTagsSuggestion: tags,
    aiFailureExplanation: record.warning || "",
    aiNextActions: uniqueStrings(actions),
    aiProviderUsed: "rules"
  };
}

function normalizeAiSuggestionResult(input, fallbackRecord, providerName) {
  const fallback = generateRuleBasedAiSuggestions(fallbackRecord);
  const source = input && typeof input === "object" ? input : {};
  return {
    aiSummary: String(source.aiSummary || source.summary || fallback.aiSummary || "").trim(),
    aiSuggestedTitle: cleanDisplayName(source.aiSuggestedTitle || source.suggestedTitle || fallback.aiSuggestedTitle || ""),
    aiSuggestedFolder: normalizePath(
      String(source.aiSuggestedFolder || source.suggestedFolder || fallback.aiSuggestedFolder || "Inbox").trim() || "Inbox"
    ),
    aiTagsSuggestion: uniqueStrings(source.aiTagsSuggestion || source.tags || fallback.aiTagsSuggestion || []).map((tag) =>
      String(tag).startsWith("#") ? String(tag) : `#${String(tag).replace(/\s+/g, "")}`
    ),
    aiFailureExplanation: String(source.aiFailureExplanation || source.failureExplanation || fallback.aiFailureExplanation || "").trim(),
    aiNextActions: uniqueStrings(source.aiNextActions || source.nextActions || fallback.aiNextActions || []),
    aiProviderUsed: String(source.aiProviderUsed || providerName || fallback.aiProviderUsed || "rules")
  };
}

function buildAiRecordSnapshot(record) {
  return {
    fileName: record.source_file_original_name || "",
    sourceType: record.source_type || "",
    notePath: record.output_note_path || "",
    currentFolder: getDisplayFolder(record),
    previewText: String(record.preview_text || "").slice(0, 4000),
    status: record.import_status || record.status || "",
    warning: record.warning || ""
  };
}

function buildOpenAiCompatibleMessages(record) {
  const snapshot = buildAiRecordSnapshot(record);
  return [
    {
      role: "system",
      content:
        "你是 Obsidian 导入助手。请基于导入文本生成简洁中文 JSON，只输出 JSON，不要输出 markdown 或解释。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "为导入资料生成摘要、标签建议、建议位置、建议标题和下一步动作",
        output_schema: {
          aiSummary: "string",
          aiSuggestedTitle: "string",
          aiSuggestedFolder: "string",
          aiTagsSuggestion: ["string"],
          aiFailureExplanation: "string",
          aiNextActions: ["string"]
        },
        constraints: [
          "使用中文",
          "aiSummary 控制在 2 句内",
          "aiTagsSuggestion 最多 4 个",
          "aiNextActions 最多 3 个",
          "aiSuggestedFolder 缺省优先返回 Inbox 或已有文件夹名称",
          "不要捏造不存在的事实"
        ],
        record: snapshot
      })
    }
  ];
}

function extractJsonObject(text) {
  const content = String(text || "").trim();
  if (!content) {
    throw new Error("AI 返回为空。");
  }

  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }

  return content;
}

async function convertLegacyWordToDocx(sourcePath, outputDirectory) {
  const converterPath = (await findCommandPath("soffice")) || (await findCommandPath("libreoffice"));
  if (!converterPath) {
    throw new Error("导入 .doc 需要先安装 LibreOffice（soffice），当前环境未检测到该依赖。");
  }

  await execFileAsync(converterPath, [
    "--headless",
    "--convert-to",
    "docx",
    "--outdir",
    outputDirectory,
    sourcePath
  ]);

  const expectedPath = path.join(outputDirectory, `${path.basename(sourcePath, path.extname(sourcePath))}.docx`);
  if (await pathExists(expectedPath)) {
    return expectedPath;
  }

  const candidates = await fs.readdir(outputDirectory);
  const fallback = candidates.find((item) => path.extname(item).toLowerCase() === ".docx");
  if (fallback) {
    return path.join(outputDirectory, fallback);
  }

  throw new Error("`.doc` 已执行预转换，但未生成 `.docx` 文件。");
}

async function extractOfficeMediaAssets(sourcePath, outputDirectory) {
  const extension = path.extname(String(sourcePath || "")).slice(1).toLowerCase();
  const mediaRoot = {
    docx: "word/media/",
    pptx: "ppt/media/",
    xlsx: "xl/media/"
  }[extension];
  if (!mediaRoot) {
    return [];
  }

  const unzipPath = (await findCommandPath("unzip")) || "/usr/bin/unzip";
  try {
    const { stdout } = await execFileAsync(unzipPath, ["-Z1", sourcePath]);
    const entries = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(mediaRoot) && !line.endsWith("/"));
    if (!entries.length) {
      return [];
    }

    await fs.mkdir(outputDirectory, { recursive: true });
    for (const entry of entries) {
      await execFileAsync(unzipPath, ["-j", "-o", sourcePath, entry, "-d", outputDirectory]);
    }

    const extracted = await fs.readdir(outputDirectory);
    return extracted
      .map((name) => path.join(outputDirectory, name))
      .filter(Boolean);
  } catch (error) {
    console.warn("Failed to extract Office media assets", error);
    return [];
  }
}

function formatImportedAtCompact(value) {
  if (!value) {
    return "未知时间";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const now = new Date();
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate();
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mm = String(parsed.getMinutes()).padStart(2, "0");

  if (sameDay) {
    return `今天 ${hh}:${mm}`;
  }

  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  if (parsed.getFullYear() === now.getFullYear()) {
    return `${month}-${day} ${hh}:${mm}`;
  }

  return `${parsed.getFullYear()}-${month}-${day} ${hh}:${mm}`;
}

function getDisplayFolder(record) {
  const notePath = normalizePath(record.output_note_path || record.filePath || record.file_path || "");
  if (!notePath) {
    return "未知位置";
  }

  const folderPath = path.posix.dirname(notePath);
  return folderPath === "." ? "根目录" : folderPath;
}

function makeVisibleActionRow(element) {
  element.style.display = "flex";
  element.style.flexWrap = "wrap";
  element.style.gap = "8px";
  element.style.marginBottom = "14px";
}

function styleActionButton(element, kind = "secondary") {
  element.style.display = "inline-flex";
  element.style.alignItems = "center";
  element.style.justifyContent = "center";
  element.style.padding = "8px 14px";
  element.style.borderRadius = "10px";
  element.style.border = "1px solid var(--background-modifier-border)";
  element.style.cursor = "pointer";
  element.style.visibility = "visible";
  element.style.opacity = "1";
  element.style.fontSize = "14px";
  element.style.lineHeight = "1.2";
  element.style.minHeight = "36px";
  element.style.boxSizing = "border-box";
  element.style.background = kind === "primary" ? "var(--interactive-accent)" : "var(--background-primary-alt)";
  element.style.color = kind === "primary" ? "var(--text-on-accent)" : "var(--text-normal)";
  element.style.borderColor =
    kind === "primary" ? "var(--interactive-accent)" : "var(--background-modifier-border)";
  if (kind === "primary") {
    element.style.fontWeight = "600";
  }
}

function createImportedNoteBanner(plugin, record) {
  const wrapper = document.createElement("div");
  wrapper.className = "smart-import-note-banner";

  const meta = document.createElement("div");
  meta.className = "smart-import-note-banner__meta";
  meta.textContent = `导入于 ${formatImportedAtLine(record.imported_at || "")} · 位置：${getDisplayFolder(record)}`;
  wrapper.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "smart-import-note-banner__actions";

  const widthAction = document.createElement("button");
  widthAction.type = "button";
  widthAction.className = "smart-import-note-banner__action";
  widthAction.textContent = `宽度：${getImportedNoteWidthLabel(plugin.settings.importedNoteWidthMode)}`;
  widthAction.addEventListener("click", async (event) => {
    event.preventDefault();
    plugin.settings.importedNoteWidthMode = getNextImportedNoteWidthMode(plugin.settings.importedNoteWidthMode);
    await plugin.saveSettings();
    await plugin.refreshImportedNoteChrome();
  });
  actions.appendChild(widthAction);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "smart-import-note-banner__action";
  action.textContent = "调整位置";
  action.addEventListener("click", async (event) => {
    event.preventDefault();
    const modal = new AdjustSaveLocationModal(plugin.app, plugin, record, async () => {
      await plugin.refreshInboxViews();
      await plugin.refreshImportedNoteChrome();
    });
    modal.open();
  });
  actions.appendChild(action);
  wrapper.appendChild(actions);

  return wrapper;
}

function getImportedNoteBannerHost(leaf) {
  const container = leaf && leaf.view && leaf.view.containerEl;
  if (!container) {
    return null;
  }

  const inlineTitle = container.querySelector(".inline-title");
  if (inlineTitle && inlineTitle.parentElement) {
    return { host: inlineTitle.parentElement, anchor: inlineTitle };
  }

  return {
    host:
      container.querySelector(".markdown-reading-view .markdown-preview-sizer") ||
      container.querySelector(".markdown-source-view.mod-cm6 .cm-sizer") ||
      container.querySelector(".markdown-source-view .cm-contentContainer") ||
      container.querySelector(".view-content"),
    anchor: null
  };
}

function updateImportedNoteContainerClasses(leaf, record, widthMode = DEFAULT_SETTINGS.importedNoteWidthMode) {
  const container = leaf && leaf.view && leaf.view.containerEl;
  if (!container) {
    return;
  }

  container.classList.remove(
    "smart-import-note--imported",
    "smart-import-note--spreadsheet",
    "smart-import-note--width-standard",
    "smart-import-note--width-wide",
    "smart-import-note--width-full"
  );
  if (!record) {
    return;
  }

  container.classList.add("smart-import-note--imported");
  container.classList.add(`smart-import-note--width-${normalizeImportedNoteWidthMode(widthMode)}`);
  const sourceType = String(record.source_type || "").toLowerCase();
  if (sourceType === "xls" || sourceType === "xlsx") {
    container.classList.add("smart-import-note--spreadsheet");
  }
}

async function getElectronModules() {
  const electron = require("electron");
  return {
    dialog: electron && electron.remote && electron.remote.dialog ? electron.remote.dialog : null,
    clipboard:
      (electron && electron.remote && electron.remote.clipboard) ||
      (electron && electron.clipboard) ||
      null,
    shell:
      (electron && electron.remote && electron.remote.shell) ||
      (electron && electron.shell) ||
      null
  };
}

module.exports = class SmartImportPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new SmartImportInboxView(leaf, this));

    this.addRibbonIcon("download", "打开文件管理", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "open-import-inbox",
      name: "打开文件管理",
      callback: async () => {
        await this.activateView();
      }
    });

    this.addCommand({
      id: "import-supported-files",
      name: "导入文件",
      callback: async () => {
        await this.openFilePicker();
      }
    });

    this.addCommand({
      id: "import-folder",
      name: "导入文件夹",
      callback: async () => {
        await this.openFolderPicker();
      }
    });

    this.addCommand({
      id: "import-recent-downloads",
      name: "导入最近下载",
      callback: async () => {
        await this.importRecentDownloads();
      }
    });

    this.addCommand({
      id: "import-finder-selection",
      name: "导入 Finder 当前选中",
      callback: async () => {
        await this.importFinderSelection();
      }
    });

    this.addCommand({
      id: "import-from-request",
      name: "自然语言导入",
      callback: async () => {
        await this.openSmartRequestModal();
      }
    });

    this.addCommand({
      id: "rebuild-file-activity-stream",
      name: "重建活动流",
      callback: async () => {
        new Notice("正在重建活动流…", 4000);
        await this.rebuildActivityStore();
        new Notice("活动流已重建。", 5000);
      }
    });

    this.addCommand({
      id: "open-dependency-install-wizard",
      name: "打开依赖安装向导",
      callback: async () => {
        await this.openDependencyInstallWizard();
      }
    });

    this.addSettingTab(new SmartImportSettingTab(this.app, this));
    await this.bootstrapActivityStoreFromImportRecords();
    await this.ingestPendingActivityEvents();
    await this.backfillActivityCardsFromVault();
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        this.maybePromptDependencyWizard().catch((error) => {
          console.warn("Failed to open dependency wizard automatically", error);
        });
      }, 1200);
    });

    this.registerDomEvent(window, ACTIVITY_BUS_EVENT, async (event) => {
      if (!event || !event.detail) {
        return;
      }
      await this.recordFileActivityEvent(event.detail);
    });
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        await this.handleVaultActivityCreate(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        await this.handleVaultActivityRename(file, oldPath);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        await this.handleVaultActivityModify(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        await this.handleVaultActivityDelete(file);
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file && typeof file.path === "string") {
          await this.maybeUpgradeImportedNoteLayout(file);
        }
        await this.refreshImportedNoteChrome();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        await this.refreshImportedNoteChrome();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", async () => {
        await this.refreshImportedNoteChrome();
      })
    );

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && typeof activeFile.path === "string") {
      await this.maybeUpgradeImportedNoteLayout(activeFile);
    }
    await this.refreshImportedNoteChrome();
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.importedNoteWidthMode = normalizeImportedNoteWidthMode(this.settings.importedNoteWidthMode);
    // Note: converterPath from data.json is intentionally preserved as-is.
    // DEFAULT_SETTINGS already uses "" so new installs auto-detect via findCommandPath.
    // Existing installs keep their saved absolute path which may be machine-specific.
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async maybePromptDependencyWizard() {
    const currentVersion = String(this.manifest && this.manifest.version || "").trim();
    if (!currentVersion || this.settings.dependencyWizardLastPromptedVersion === currentVersion) {
      return;
    }

    const environment = await this.checkEnvironment(true);
    if (environment.ok) {
      return;
    }

    this.settings.dependencyWizardLastPromptedVersion = currentVersion;
    await this.saveSettings();
    new Notice(
      "Smart Import 已安装。md/txt 可直接导入；如需导入 docx、pdf、pptx、xlsx、xls、doc、epub、mobi、azw3，请在设置里打开“依赖安装向导”。",
      9000
    );
  }

  async loadActivityStore() {
    if (!(await this.app.vault.adapter.exists(INTERNAL_ACTIVITY_STORE_PATH))) {
      return { version: ACTIVITY_STORE_VERSION, cards: [] };
    }

    try {
      const content = await this.app.vault.adapter.read(INTERNAL_ACTIVITY_STORE_PATH);
      const parsed = JSON.parse(content);
      return {
        version: Number(parsed.version) || ACTIVITY_STORE_VERSION,
        cards: Array.isArray(parsed.cards) ? parsed.cards : []
      };
    } catch (error) {
      console.warn("Failed to load activity store", error);
      return { version: ACTIVITY_STORE_VERSION, cards: [] };
    }
  }

  async saveActivityStore(cards) {
    await ensureFolder(this.app, INTERNAL_ACTIVITY_DIR);
    await this.app.vault.adapter.write(INTERNAL_ACTIVITY_STORE_PATH, buildActivityStorePayload(cards));
  }

  async removeActivityCards(predicate) {
    const store = await this.loadActivityStore();
    const currentCards = Array.isArray(store.cards) ? store.cards : [];
    const nextCards = currentCards.filter((card) => !predicate(card));
    if (nextCards.length === currentCards.length) {
      return false;
    }

    await this.saveActivityStore(nextCards);
    await this.refreshInboxViews();
    return true;
  }

  async listActivityCards(sortMode = this.settings.activitySortMode) {
    await this.ingestPendingActivityEvents();
    const store = await this.loadActivityStore();
    return sortActivityCards(store.cards, sortMode);
  }

  async rebuildActivityStore() {
    await this.saveActivityStore([]);
    await this.bootstrapActivityStoreFromImportRecords();
    await this.ingestPendingActivityEvents();
    await this.backfillActivityCardsFromVault();
    await this.refreshInboxViews();
  }

  async recordFileActivityEvent(input) {
    const event = normalizeActivityEvent(input);
    if (!event.filePath || !isTrackedActivityPath(event.filePath)) {
      return null;
    }

    const store = await this.loadActivityStore();
    const existingCard = findExistingActivityCard(store.cards, event);
    const nextCard = buildActivityCardFromEvent(existingCard, event);

    const nextCards = Array.isArray(store.cards) ? [...store.cards] : [];
    if (existingCard) {
      const index = nextCards.findIndex((card) => card.id === existingCard.id);
      if (index >= 0) {
        nextCards[index] = nextCard;
      } else {
        nextCards.push(nextCard);
      }
    } else {
      nextCards.push(nextCard);
    }

    await this.saveActivityStore(nextCards);
    await this.refreshInboxViews();
    return nextCard;
  }

  async ingestPendingActivityEvents() {
    const eventsDir = this.getAbsoluteVaultPath(INTERNAL_ACTIVITY_EVENTS_DIR);
    if (!(await pathExists(eventsDir))) {
      return;
    }

    const entries = await fs.readdir(eventsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
        continue;
      }

      const absolutePath = path.join(eventsDir, entry.name);
      try {
        const content = await fs.readFile(absolutePath, "utf8");
        const parsed = JSON.parse(content);
        await this.recordFileActivityEvent(parsed);
      } catch (error) {
        console.warn(`Failed to ingest activity event: ${entry.name}`, error);
      } finally {
        await fs.rm(absolutePath, { force: true }).catch(() => {});
      }
    }
  }

  async bootstrapActivityStoreFromImportRecords() {
    const records = await this.listImportRecords({ skipAiHydration: true });
    if (!records.length) {
      return;
    }

    for (const record of records) {
      const notePath = normalizePath(record.output_note_path || "");
      if (!notePath || !isTrackedActivityPath(notePath)) {
        continue;
      }

      await this.recordFileActivityEvent({
        id: `bootstrap-${record.id || createJobId()}`,
        eventType: "file_imported",
        sourceModule: "import",
        filePath: notePath,
        fileName: path.basename(notePath),
        fileType: record.source_type || inferActivityFileType(notePath),
        timestamp: record.imported_at || getTimestamp(),
        metadata: {
          importRecordPath: record.import_record_path || "",
          importStatus: record.import_status || record.status || "imported_to_inbox",
          status: record.import_status || record.status || "ready",
          canOpen: (record.import_status || record.status) !== "failed",
          canRelocate: (record.import_status || record.status) !== "failed",
          enteredAt: record.imported_at || getTimestamp(),
          sourceFilePath: record.source_file_path || "",
          sourceFileStoredPath: record.source_file_stored_path || ""
        }
      });
    }
  }

  async backfillActivityCardsFromVault() {
    const store = await this.loadActivityStore();
    const existingCards = new Map((store.cards || []).map((card) => [normalizePath(card.filePath || ""), card]));
    const files = await listVaultBusinessFilesRecursive(this.getVaultBasePath());

    for (const normalizedPath of files) {
      const existingCard = existingCards.get(normalizedPath);
      const absolutePath = this.getAbsoluteVaultPath(normalizedPath);
      let stats = null;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        continue;
      }

      const sourceModule = inferActivitySourceFromPath(normalizedPath);
      const enteredAt = new Date(stats && stats.ctime ? stats.ctime : Date.now()).toISOString();
      const lastEditedAt = new Date(stats && stats.mtime ? stats.mtime : Date.now()).toISOString();
      const eventType = "file_created";
      const extension = inferActivityFileType(normalizedPath);
      const metadata = {
        ...(existingCard && existingCard.metadata ? existingCard.metadata : {}),
        status: "ready",
        canOpen: true,
        canRelocate: true,
        enteredAt,
        lastEditedAt
      };

      if (extension === "md") {
        const file = this.app.vault.getAbstractFileByPath(normalizedPath);
        const content = file instanceof TFile ? await this.app.vault.cachedRead(file).catch(() => "") : "";
        metadata.contentHash = hashActivityContent(content);
      }

      await this.recordFileActivityEvent({
        eventType,
        sourceModule,
        filePath: normalizedPath,
        fileName: path.basename(normalizedPath),
        fileType: extension,
        timestamp: existingCard && existingCard.enteredAt ? existingCard.enteredAt : enteredAt,
        metadata
      });
    }

    await this.removeActivityCards((card) => !files.includes(normalizePath(card.filePath || "")));
  }

  async handleVaultActivityCreate(file) {
    if (!file || !file.path || !isBusinessActivityPath(file.path)) {
      return;
    }

    const store = await this.loadActivityStore();
    const existing = store.cards.find((card) => normalizePath(card.filePath || "") === normalizePath(file.path));
    if (existing) {
      return;
    }

    const extension = inferActivityFileType(file.path);
    let contentHash = "";
    if (extension === "md") {
      const content = await this.app.vault.cachedRead(file).catch(() => "");
      contentHash = hashActivityContent(content);
    }

    await this.recordFileActivityEvent({
      eventType: "file_created",
      sourceModule: inferActivitySourceFromPath(file.path),
      filePath: file.path,
      fileName: file.name,
      fileType: extension,
      timestamp: getTimestamp(),
      metadata: {
        status: "ready",
        canOpen: true,
        canRelocate: true,
        lastEditedAt: getTimestamp(),
        ...(contentHash ? { contentHash } : {})
      }
    });
  }

  async handleVaultActivityRename(file, oldPath) {
    if (!file || !file.path || !oldPath) {
      return;
    }

    const nextPath = normalizePath(file.path);
    const previousPath = normalizePath(oldPath);
    const nextIsBusiness = isBusinessActivityPath(nextPath);
    const previousIsBusiness = isBusinessActivityPath(previousPath);
    if (!nextIsBusiness && !previousIsBusiness) {
      return;
    }

    if (!nextIsBusiness && previousIsBusiness) {
      await this.removeActivityCards((card) => normalizePath(card.filePath || "") === previousPath);
      return;
    }

    await this.recordFileActivityEvent({
      eventType: "file_moved",
      sourceModule: inferActivitySourceFromPath(nextPath || previousPath),
      filePath: nextPath,
      fileName: file.name || path.basename(nextPath),
      fileType: inferActivityFileType(nextPath),
      timestamp: getTimestamp(),
      metadata: {
        previousFilePath: previousPath,
        status: "ready",
        canOpen: true,
        canRelocate: true
      }
    });
  }

  async handleVaultActivityModify(file) {
    if (!file || !file.path || !isBusinessActivityPath(file.path)) {
      return;
    }

    const store = await this.loadActivityStore();
    const existing = store.cards.find((card) => normalizePath(card.filePath || "") === normalizePath(file.path));
    const extension = inferActivityFileType(file.path);
    const nextTimestamp = getTimestamp();
    const trustedResearchFolders = await this.getTrustedResearchExportFolders();

    let contentHash = "";
    if (extension === "md") {
      const content = await this.app.vault.cachedRead(file).catch(() => "");
      contentHash = hashActivityContent(content);
      if (existing && (!contentHash || contentHash === String(existing.metadata && existing.metadata.contentHash || ""))) {
        return;
      }
    }

    if (!existing) {
      await this.recordFileActivityEvent({
        eventType: "file_created",
        sourceModule: inferActivitySourceFromPath(file.path),
        filePath: file.path,
        fileName: file.name || path.basename(file.path),
        fileType: extension,
        timestamp: nextTimestamp,
        metadata: {
          status: "ready",
          canOpen: true,
          canRelocate: true,
          enteredAt: nextTimestamp,
          lastEditedAt: nextTimestamp,
          ...(contentHash ? { contentHash } : {})
        }
      });
      return;
    }

    const nextMetadata = mergeActivityMetadata(existing.metadata, {});
    if (contentHash) {
      nextMetadata.contentHash = contentHash;
    }
    nextMetadata.lastEditedAt = nextTimestamp;
    await this.recordFileActivityEvent({
      eventType: existing.eventType || "file_created",
      sourceModule: existing.sourceModule || "manual",
      filePath: file.path,
      fileName: file.name || path.basename(file.path),
      fileType: extension,
      timestamp: existing.enteredAt || nextTimestamp,
      metadata: {
        ...nextMetadata,
        enteredAt: existing.enteredAt || nextTimestamp,
        status: existing.status || "ready",
        canOpen: existing.canOpen !== false,
        canRelocate: existing.canRelocate !== false
      }
    });
  }

  async handleVaultActivityDelete(file) {
    const normalizedPath = normalizePath(file && file.path || "");
    if (!normalizedPath) {
      return;
    }

    if (!isBusinessActivityPath(normalizedPath)) {
      return;
    }

    await this.removeActivityCards((card) => normalizePath(card.filePath || "") === normalizedPath);
  }

  getVaultBasePath() {
    return this.app.vault.adapter.getBasePath();
  }

  getAbsoluteVaultPath(vaultRelativePath) {
    return path.join(this.getVaultBasePath(), normalizePath(vaultRelativePath));
  }

  async checkEnvironment(force = false) {
    const now = Date.now();
    if (!force && this.environmentStatus && now - this.environmentStatus.checkedAt < 5000) {
      return this.environmentStatus;
    }

    const converterPath = (this.settings.converterPath || "").trim();
    // When no explicit path is set, probe via login shell so ~/.local/bin and
    // other user-specific paths (added by .zshrc / .profile) are included.
    // Electron's process PATH is typically too narrow to find pip-installed tools.
    const command = converterPath || await findCommandPath("markitdown") || "markitdown";
    const result = {
      checkedAt: now,
      command,
      ok: false,
      detail: "",
      version: "",
      optionalDependencies: []
    };

    try {
      const response = await execFileAsync(command, ["--version"]);
      const versionText = `${response.stdout || ""}${response.stderr || ""}`.trim();
      const optionalDependencies = [];
      if (!(await findCommandPath("python3"))) {
        optionalDependencies.push("python3（PDF OCR 备用链路）");
      }
      if (!(await findCommandPath("tesseract"))) {
        optionalDependencies.push("tesseract（PDF OCR 备用链路）");
      }
      if (!(await findCommandPath("soffice")) && !(await findCommandPath("libreoffice"))) {
        optionalDependencies.push("LibreOffice/soffice（导入 .doc）");
      }
      if (!(await findCommandPath("pandoc"))) {
        optionalDependencies.push("pandoc（EPUB 备用转换）");
      }
      if (!(await findCommandPath("ebook-convert"))) {
        optionalDependencies.push("Calibre/ebook-convert（MOBI、AZW3 备用转换）");
      }
      if (await findCommandPath("python3")) {
        try {
          await execFileAsync("python3", ["-c", "import pypdfium2"]);
        } catch (error) {
          optionalDependencies.push("pypdfium2 Python 包（PDF OCR 备用链路）");
        }
      }
      result.ok = true;
      result.version = versionText;
      result.optionalDependencies = optionalDependencies;
      result.detail = [
        versionText || `${command} is available.`,
        optionalDependencies.length
          ? `可选依赖缺失：${optionalDependencies.join("、")}`
          : "可选依赖已就绪。"
      ].join(" ");
    } catch (error) {
      const detail = (error.stderr || error.message || "Unknown error").trim();
      result.detail = detail || "转换器检查失败。";
    }

    this.environmentStatus = result;
    return result;
  }

  async checkConversionEnvironment(extension, force = false) {
    const normalizedExtension = String(extension || "").toLowerCase();
    if (!EBOOK_EXTENSIONS.has(normalizedExtension)) {
      return this.checkEnvironment(force);
    }

    const now = Date.now();
    const cacheKey = `ebook:${normalizedExtension}`;
    if (
      !force &&
      this.ebookEnvironmentStatus &&
      this.ebookEnvironmentStatus.cacheKey === cacheKey &&
      now - this.ebookEnvironmentStatus.checkedAt < 5000
    ) {
      return this.ebookEnvironmentStatus;
    }

    const converterPath = (this.settings.converterPath || "").trim();
    const markitdownCommand = converterPath || await findCommandPath("markitdown") || "";
    const pandocCommand = await findCommandPath("pandoc");
    const ebookConvertCommand = await findCommandPath("ebook-convert");
    const result = {
      checkedAt: now,
      cacheKey,
      command: markitdownCommand || (normalizedExtension === "epub" ? pandocCommand : "") || ebookConvertCommand,
      markitdownCommand,
      pandocCommand,
      ebookConvertCommand,
      ok: Boolean(
        markitdownCommand ||
        (normalizedExtension === "epub" && pandocCommand) ||
        ebookConvertCommand
      ),
      detail: "",
      version: "",
      optionalDependencies: []
    };

    if (!result.ok) {
      result.detail =
        normalizedExtension === "epub"
          ? "导入 EPUB 需要 markitdown 或 pandoc。请先安装其中一个转换器。"
          : `导入 ${normalizedExtension.toUpperCase()} 需要 markitdown 电子书转换支持或 Calibre（ebook-convert）。`;
      this.ebookEnvironmentStatus = result;
      return result;
    }

    const versions = [];
    for (const [name, command, args] of [
      ["markitdown", markitdownCommand, ["--version"]],
      ["pandoc", pandocCommand, ["--version"]],
      ["ebook-convert", ebookConvertCommand, ["--version"]]
    ]) {
      if (!command) {
        continue;
      }
      try {
        const response = await execFileAsync(command, args);
        const versionText = `${response.stdout || ""}${response.stderr || ""}`.trim().split(/\r?\n/)[0];
        versions.push(versionText ? `${name}: ${versionText}` : `${name}: available`);
      } catch {
        versions.push(`${name}: available`);
      }
    }

    result.version = versions.join("; ");
    result.detail = result.version || "电子书转换器可用。";
    this.ebookEnvironmentStatus = result;
    return result;
  }

  async convertWithMarkitdown(command, sourcePath, outputPath) {
    await execFileAsync(command, [sourcePath, "-o", outputPath]);
    return fs.readFile(outputPath, "utf8");
  }

  async convertEbookToMarkdown(sourcePath, extension, tempDir, environment) {
    const normalizedExtension = String(extension || "").toLowerCase();
    const errors = [];
    const markdownPath = path.join(tempDir, "ebook.md");
    const textPath = path.join(tempDir, "ebook.txt");

    if (environment.markitdownCommand) {
      try {
        return {
          content: await this.convertWithMarkitdown(environment.markitdownCommand, sourcePath, markdownPath),
          converterName: "markitdown"
        };
      } catch (error) {
        errors.push(`markitdown: ${(error.stderr || error.message || error).toString().trim()}`);
      }
    }

    if (normalizedExtension === "epub" && environment.pandocCommand) {
      try {
        await execFileAsync(environment.pandocCommand, [sourcePath, "-t", "gfm", "-o", markdownPath]);
        return {
          content: await fs.readFile(markdownPath, "utf8"),
          converterName: "pandoc"
        };
      } catch (error) {
        errors.push(`pandoc: ${(error.stderr || error.message || error).toString().trim()}`);
      }
    }

    if (environment.ebookConvertCommand) {
      try {
        await execFileAsync(environment.ebookConvertCommand, [sourcePath, textPath]);
        return {
          content: await fs.readFile(textPath, "utf8"),
          converterName: "ebook-convert"
        };
      } catch (error) {
        errors.push(`ebook-convert: ${(error.stderr || error.message || error).toString().trim()}`);
      }
    }

    throw new Error(errors.filter(Boolean).join("\n") || `${normalizedExtension.toUpperCase()} 电子书转换失败。`);
  }

  async buildDependencyInstallPlan(force = false) {
    const environment = await this.checkEnvironment(force);
    const platform = process.platform;
    const platformLabel = getPlatformLabel(platform);
    const explicitConverterPath = String(this.settings.converterPath || "").trim();
    const detectedMarkitdownPath = await findCommandPath("markitdown");
    const hasMarkitdown = Boolean(detectedMarkitdownPath);
    const hasBrew = platform === "darwin" ? Boolean(await findCommandPath("brew")) : false;
    const hasPython3 = Boolean(await findCommandPath("python3"));
    const hasPipx = Boolean(await findCommandPath("pipx"));
    const hasTesseract = Boolean(await findCommandPath("tesseract"));
    const hasLibreOffice = Boolean((await findCommandPath("soffice")) || (await findCommandPath("libreoffice")));
    const hasPandoc = Boolean(await findCommandPath("pandoc"));
    const hasEbookConvert = Boolean(await findCommandPath("ebook-convert"));
    let hasPypdfium2 = false;
    if (hasPython3) {
      try {
        await execFileAsync("python3", ["-c", "import pypdfium2"]);
        hasPypdfium2 = true;
      } catch (error) {
      }
    }

    const converterPathInvalid = explicitConverterPath ? !(await pathExists(explicitConverterPath)) : false;
    const missingItems = [];
    const notes = [];

    if (!environment.ok && !hasMarkitdown) {
      missingItems.push({
        id: "markitdown",
        label: "markitdown",
        required: true,
        detail: "导入 docx、pdf、pptx、xlsx、xls 等需要先转换成 Markdown 的文件时必需。"
      });
    }
    if (!hasPython3) {
      missingItems.push({
        id: "python3",
        label: "python3",
        required: false,
        detail: "PDF OCR 备用链路依赖。"
      });
    }
    if (!hasTesseract) {
      missingItems.push({
        id: "tesseract",
        label: "tesseract",
        required: false,
        detail: "扫描版 PDF 的 OCR 识别依赖。"
      });
    }
    if (!hasPypdfium2) {
      missingItems.push({
        id: "pypdfium2",
        label: "pypdfium2",
        required: false,
        detail: "OCR 脚本的 Python 依赖。"
      });
    }
    if (!hasLibreOffice) {
      missingItems.push({
        id: "libreoffice",
        label: "LibreOffice / soffice",
        required: false,
        detail: "导入旧版 .doc 文件时先转成 .docx。"
      });
    }
    if (!hasPandoc) {
      missingItems.push({
        id: "pandoc",
        label: "pandoc",
        required: false,
        detail: "EPUB 电子书导入的备用转换器。"
      });
    }
    if (!hasEbookConvert) {
      missingItems.push({
        id: "ebook-convert",
        label: "Calibre / ebook-convert",
        required: false,
        detail: "MOBI、AZW3 电子书导入的备用转换器。"
      });
    }

    if (converterPathInvalid) {
      notes.push("当前“转换器路径”配置指向不存在的文件。你可以清空这个设置，让插件回退到系统 PATH 自动探测。");
    } else if (!environment.ok && hasMarkitdown) {
      notes.push("系统已经检测到 markitdown，但当前调用仍失败。请优先检查“转换器路径”设置和 shell PATH。");
    }

    if (platform !== "darwin") {
      notes.push("当前版本的半自动安装向导只支持 macOS 自动打开终端执行脚本。其他平台会提供命令复制，但需要你手动执行。");
    }

    const shellSteps = [];
    if (platform === "darwin" && missingItems.length) {
      shellSteps.push("#!/bin/bash");
      shellSteps.push("set -e");
      shellSteps.push("echo \"Smart Import 依赖安装向导（macOS）\"");
      shellSteps.push("echo");

      if (!hasBrew) {
        shellSteps.push("echo \"未检测到 Homebrew，开始安装…\"");
        shellSteps.push("/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"");
        shellSteps.push("if [ -x /opt/homebrew/bin/brew ]; then");
        shellSteps.push("  eval \"$(/opt/homebrew/bin/brew shellenv)\"");
        shellSteps.push("elif [ -x /usr/local/bin/brew ]; then");
        shellSteps.push("  eval \"$(/usr/local/bin/brew shellenv)\"");
        shellSteps.push("fi");
      }

      const brewPackages = [];
      if (!hasPython3) brewPackages.push("python");
      if (!hasTesseract) brewPackages.push("tesseract");
      if (!hasPandoc) brewPackages.push("pandoc");
      if (!hasLibreOffice) brewPackages.push("libreoffice");
      if (!hasPipx && missingItems.some((item) => item.id === "markitdown")) {
        brewPackages.push("pipx");
      }
      if (brewPackages.length) {
        shellSteps.push(`brew install ${uniqueStrings(brewPackages).join(" ")}`);
      }

      if (!hasEbookConvert) {
        shellSteps.push("if ! command -v ebook-convert >/dev/null 2>&1; then");
        shellSteps.push("  brew install --cask calibre || true");
        shellSteps.push("fi");
      }

      if (missingItems.some((item) => item.id === "markitdown")) {
        shellSteps.push("if ! command -v pipx >/dev/null 2>&1; then");
        shellSteps.push("  if command -v brew >/dev/null 2>&1; then");
        shellSteps.push("    brew install pipx");
        shellSteps.push("  elif command -v python3 >/dev/null 2>&1; then");
        shellSteps.push("    python3 -m pip install --user pipx");
        shellSteps.push("  fi");
        shellSteps.push("fi");
        shellSteps.push("if command -v pipx >/dev/null 2>&1; then");
        shellSteps.push("  pipx ensurepath || true");
        shellSteps.push("  pipx list | grep -q \"package markitdown\" || pipx install markitdown");
        shellSteps.push("else");
        shellSteps.push("  echo \"未能自动安装 pipx，请手动安装 markitdown。\"");
        shellSteps.push("fi");
      }

      if (missingItems.some((item) => item.id === "pypdfium2")) {
        shellSteps.push("if command -v python3 >/dev/null 2>&1; then");
        shellSteps.push("  python3 -m pip install --user pypdfium2");
        shellSteps.push("else");
        shellSteps.push("  echo \"未检测到 python3，跳过 pypdfium2 安装。\"");
        shellSteps.push("fi");
      }

      shellSteps.push("echo");
      shellSteps.push("echo \"安装命令已执行完成。请回到 Smart Import 设置页点击‘重新检测环境’。\"");
    }

    const manualCommands = platform === "darwin"
      ? (shellSteps.length
        ? shellSteps.join("\n")
        : "# 当前未检测到需要安装的本地依赖。")
      : [
          "# 当前平台暂不支持插件内自动打开终端安装。",
          "# 请按你的系统包管理方式手动安装所需依赖：",
          "# 必需：markitdown",
          "# 可选：python3、tesseract、pypdfium2、LibreOffice / soffice、pandoc、Calibre / ebook-convert"
        ].join("\n");

    return {
      platform,
      platformLabel,
      environment,
      missingItems,
      notes,
      hasAutoInstall: platform === "darwin" && shellSteps.length > 0,
      commandText: manualCommands,
      canResetConverterPath: converterPathInvalid
    };
  }

  async copyTextToClipboard(text) {
    const { clipboard } = await getElectronModules();
    if (!clipboard || typeof clipboard.writeText !== "function") {
      return false;
    }

    clipboard.writeText(String(text || ""));
    return true;
  }

  async openDependencyInstallWizard() {
    const modal = new DependencyInstallWizardModal(this.app, this);
    modal.open();
  }

  async runDependencyInstallPlan(plan) {
    if (!plan || !plan.hasAutoInstall || !plan.commandText) {
      throw new Error("当前平台不支持自动打开终端执行安装脚本。");
    }

    const scriptPath = path.join(os.tmpdir(), `smart-import-install-${Date.now()}.sh`);
    await fs.writeFile(scriptPath, `${String(plan.commandText || "").trim()}\n`, "utf8");
    await fs.chmod(scriptPath, 0o755);

    if (process.platform === "darwin") {
      const appleScript = [
        `set smartImportScript to POSIX file "${scriptPath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`,
        'tell application "Terminal"',
        "activate",
        'do script "/bin/bash " & quoted form of POSIX path of smartImportScript',
        "end tell"
      ];
      await execFileAsync("/usr/bin/osascript", appleScript.flatMap((line) => ["-e", line]));
      return scriptPath;
    }

    throw new Error("当前平台暂不支持自动打开终端执行安装脚本。");
  }

  async ensurePdfOcrScriptPath() {
    const scriptPath = path.join(__dirname, "ocr_pdf.py");
    try {
      const existing = await fs.readFile(scriptPath, "utf8");
      if (existing.trim() === EMBEDDED_PDF_OCR_SCRIPT.trim()) {
        return scriptPath;
      }
    } catch (error) {
    }

    await fs.writeFile(scriptPath, `${EMBEDDED_PDF_OCR_SCRIPT.trim()}\n`, "utf8");
    await fs.chmod(scriptPath, 0o755);
    return scriptPath;
  }

  async getMacClipboardFilePaths() {
    if (process.platform !== "darwin") {
      return [];
    }

    const script = [
      "try",
      "set itemPaths to {}",
      "try",
      "set end of itemPaths to POSIX path of (the clipboard as alias)",
      "end try",
      "try",
      "set c to the clipboard",
      "repeat with oneItem in (list of c)",
      "set end of itemPaths to POSIX path of oneItem",
      "end repeat",
      "end try",
      "set AppleScript's text item delimiters to linefeed",
      "return itemPaths as text",
      "on error",
      "return \"\"",
      "end try"
    ];

    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", script.flatMap((line) => ["-e", line]));
      return uniqueStrings(String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    } catch (error) {
      console.warn("Failed to read file paths from macOS clipboard", error);
      return [];
    }
  }

  async getClipboardFileCandidates(rawCandidates = [], extraPaths = []) {
    const allPathHints = uniqueStrings([
      ...extraPaths,
      ...rawCandidates.flatMap((candidate) => extractPathsFromArbitraryText(candidate))
    ]);
    const macClipboardPaths = await this.getMacClipboardFilePaths();
    const existingPaths = await collectExistingLocalPaths([...allPathHints, ...macClipboardPaths]);
    const importablePaths = await collectImportablePaths(existingPaths, {
      maxDepth: 4,
      maxFilesPerDirectory: 100
    });

    return {
      existingPaths,
      importablePaths
    };
  }

  async runPdfOcrFallback(sourcePath, tempDir) {
    const tesseractPath = await findCommandPath("tesseract");
    if (!tesseractPath) {
      return "";
    }

    const outputPath = path.join(tempDir, "pdf-ocr.md");
    try {
      const scriptPath = await this.ensurePdfOcrScriptPath();
      await execFileAsync("python3", [
        scriptPath,
        "--input",
        sourcePath,
        "--output",
        outputPath
      ]);
      if (!(await pathExists(outputPath))) {
        return "";
      }

      return fs.readFile(outputPath, "utf8");
    } catch (error) {
      console.warn("PDF OCR fallback failed", error);
      return "";
    }
  }

  async enhancePdfMarkdown(sourcePath, markdown, tempDir) {
    const cleanedBase = cleanOcrMarkdown(markdown);
    if (!isLikelyLowQualityPdfMarkdown(cleanedBase)) {
      return {
        content: cleanedBase,
        status: "imported_to_inbox",
        warning: "",
        manualNextStep: ""
      };
    }

    const ocrMarkdown = cleanOcrMarkdown(await this.runPdfOcrFallback(sourcePath, tempDir));
    if (!ocrMarkdown.trim()) {
      return {
        content: cleanedBase,
        status: "partial_success",
        warning: "PDF 文本提取质量较低，未能完成 OCR 补救，请查看原件。",
        manualNextStep: "建议打开原始 PDF，人工核对正文、表格和关键数字。"
      };
    }

    const correctedMarkdown =
      ocrMarkdown.replace(/\s+/g, "").length > cleanedBase.replace(/\s+/g, "").length * 1.2
        ? await this.correctOcrMarkdownWithAi(ocrMarkdown)
        : ocrMarkdown;

    return {
      content: correctedMarkdown,
      status: "partial_success",
      warning: "已使用 OCR 备用链路提取 PDF 文本，建议与原件核对。",
      manualNextStep: "重点检查表格、金额、时间和专有名词。"
    };
  }

  async openFilePicker() {
    const paths = await this.selectFiles();
    if (!paths.length) {
      return;
    }
    await this.openImportReview(paths, "file-picker", {
      title: "确认导入文件",
      description: "请确认要导入的文件、保存目录和是否保留原件。"
    });
  }

  async openFolderPicker() {
    const directoryPath = await this.selectDirectory();
    if (!directoryPath) {
      return;
    }
    await this.openImportReview([directoryPath], "folder-picker", {
      title: "确认导入文件夹",
      description: "系统会递归扫描该文件夹中的文件，并在确认后导入。"
    });
  }

  async getFinderSelectionPaths() {
    if (process.platform !== "darwin") {
      return [];
    }

    const script = [
      "try",
      "tell application \"Finder\"",
      "set selectedItems to selection as alias list",
      "end tell",
      "set outputLines to {}",
      "repeat with selectedItem in selectedItems",
      "set end of outputLines to POSIX path of selectedItem",
      "end repeat",
      "set AppleScript's text item delimiters to linefeed",
      "return outputLines as text",
      "on error",
      "return \"\"",
      "end try"
    ];

    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", script.flatMap((line) => ["-e", line]));
      return uniqueStrings(String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    } catch (error) {
      console.warn("Failed to read Finder selection", error);
      return [];
    }
  }

  async importFinderSelection() {
    const paths = await this.getFinderSelectionPaths();
    if (!paths.length) {
      new Notice("没有检测到 Finder 当前选中的文件或文件夹。", 6000);
      return;
    }

    await this.openImportReview(paths, "finder-selection", {
      title: "确认导入 Finder 当前选中项",
      description: "系统会读取 Finder 当前选中的文件或文件夹，并在确认后导入。"
    });
  }

  parseSmartImportRequest(query) {
    const text = String(query || "").trim();
    const lowered = text.toLowerCase();
    const fileTypes = [];
    if (/(ppt|pptx|slide|slides|汇报|演示|课件)/i.test(text)) fileTypes.push("pptx");
    if (/(pdf|扫描|发票|合同扫描)/i.test(text)) fileTypes.push("pdf");
    if (/(excel|xlsx|xls|表格|预算|清单)/i.test(text)) fileTypes.push("xlsx", "xls");
    if (/(word|docx|doc|文档|纪要|方案|说明)/i.test(text)) fileTypes.push("docx", "doc");
    if (/(txt|文本|纯文本)/i.test(text)) fileTypes.push("txt");
    if (/(markdown|md|笔记)/i.test(text)) fileTypes.push("md");

    const tokens = uniqueStrings(
      text
        .split(/[\s,，。.!?？、/\\|:：;；"'“”‘’()\[\]{}<>《》]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .filter((item) => !/^(导入|import|文件|文档|那个|一下|今天|最近|刚刚|我|的)$/i.test(item))
    );

    return {
      query: text,
      fileTypes: uniqueStrings(fileTypes),
      keywords: tokens,
      preferRecent: /(今天|刚|最近|recent|latest|刚刚)/i.test(text),
      wantsDownloads: /(下载|downloads?)/i.test(text),
      wantsDesktop: /(桌面|desktop)/i.test(text),
      wantsFinder: /(finder|选中|当前选中|当前选择)/i.test(text),
      wantsClipboard: /(复制|clipboard|剪贴板)/i.test(text)
    };
  }

  async searchSmartImportRequest(query) {
    const parsed = this.parseSmartImportRequest(query);
    const candidateEntries = [];
    const rootHints = [];
    if (parsed.wantsDownloads || !parsed.wantsDesktop) {
      rootHints.push(path.join(os.homedir(), "Downloads"));
    }
    rootHints.push(path.join(os.homedir(), "Desktop"));

    if (parsed.wantsFinder) {
      const finderSelection = await this.getFinderSelectionPaths();
      candidateEntries.push(...(await collectDiscoveredFileEntries(finderSelection, {
        maxDepth: 4,
        maxFilesPerDirectory: 100
      })));
    }

    if (parsed.wantsClipboard) {
      const clipboardSnapshot = await this.readSystemClipboardSnapshot();
      candidateEntries.push(...(await collectDiscoveredFileEntries([
        ...clipboardSnapshot.importablePaths,
        ...clipboardSnapshot.existingPaths
      ], {
        maxDepth: 2,
        maxFilesPerDirectory: 50
      })));
    }

    candidateEntries.push(...(await collectDiscoveredFileEntries(rootHints, {
      maxDepth: 4,
      maxFilesPerDirectory: 200
    })));

    const scored = [];
    for (const entry of candidateEntries) {
      const normalizedPath = normalizePossibleFilePath(entry.path);
      if (!normalizedPath) {
        continue;
      }

      let score = 0;
      if (parsed.fileTypes.length) {
        if (parsed.fileTypes.includes(entry.extension)) {
          score += 50;
        } else {
          score -= 10;
        }
      }

      const comparable = `${path.basename(normalizedPath)} ${normalizedPath}`.toLowerCase();
      parsed.keywords.forEach((keyword) => {
        if (comparable.includes(keyword.toLowerCase())) {
          score += 15;
        }
      });

      try {
        const stats = await fs.stat(normalizedPath);
        const modifiedAt = getFileActivityTimestamp(stats);
        if (parsed.preferRecent) {
          const ageHours = Math.max(0, (Date.now() - modifiedAt) / (1000 * 60 * 60));
          score += Math.max(0, 24 - ageHours);
        }
        scored.push({
          path: normalizedPath,
          score,
          modifiedAt
        });
      } catch {
        continue;
      }
    }

    return scored
      .sort((left, right) => right.score - left.score || right.modifiedAt - left.modifiedAt)
      .filter((item, index) => item.score > 0 || index < 10)
      .slice(0, 20)
      .map((item) => item.path);
  }

  async openSmartRequestModal() {
    const modal = new SmartImportRequestModal(this.app, this);
    modal.open();
  }

  async openImportReview(paths, importMethod, options = {}) {
    const discoveredEntries = await collectDiscoveredFileEntries(paths, {
      maxDepth: 4,
      maxFilesPerDirectory: 200
    });
    if (!discoveredEntries.length) {
      new Notice("没有识别到可导入的文件。", 6000);
      return { imported: false, reason: "empty" };
    }

    return new ImportReviewModal(this.app, this, {
      ...options,
      importMethod,
      entries: discoveredEntries
    }).openAndImport();
  }

  suggestClipboardTitle(text) {
    const lines = normalizePastedTextContent(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const firstLine = lines[0] || "";
    const headingMatch = firstLine.match(/^#+\s+(.+)$/);
    const rawTitle = headingMatch ? headingMatch[1] : firstLine;
    const cleaned = cleanDisplayName(rawTitle).slice(0, 60);
    if (cleaned) {
      return cleaned;
    }

    const stamp = new Date();
    const hh = String(stamp.getHours()).padStart(2, "0");
    const mm = String(stamp.getMinutes()).padStart(2, "0");
    return `剪贴板导入 ${hh}${mm}`;
  }

  async importClipboardText(text, importMethod = "clipboard-paste-text") {
    const content = repairBrokenMarkdownTables(normalizePastedTextContent(text)).trim();
    if (!content) {
      return null;
    }

    const inboxRoot = normalizePath(this.settings.outputDir || DEFAULT_SETTINGS.outputDir);
    const title = this.suggestClipboardTitle(content);
    const jobId = createJobId();
    const importedAt = getTimestamp();
    const outputNotePath = await getUniqueVaultPath(this.app, `${inboxRoot}/${title}.md`, {
      separator: " "
    });
    const importRecordPath = normalizePath(`${INTERNAL_RECORDS_DIR}/${jobId}.json`);

    await ensureFolder(this.app, inboxRoot);
    await ensureFolder(this.app, INTERNAL_RECORDS_DIR);

    const markdown = buildMarkdownDocument({
      title,
      sourceFileName: `${title}.md`,
      sourceFileType: "md",
      sourceFilePath: "clipboard://text",
      sourceFileStoredPath: "",
      importedAt,
      importMethod,
      converterName: "clipboard-direct",
      status: "imported_to_inbox",
      outputNotePath,
      outputAssetsPath: "",
      importRecordPath,
      content
    });
    const file = await this.app.vault.create(outputNotePath, markdown);
    await this.saveImportRecord(importRecordPath, {
      id: jobId,
      sourceFileOriginalName: `${title}.md`,
      sourceFilePath: "clipboard://text",
      sourceFileStoredPath: "",
      outputNotePath,
      outputAssetsPath: "",
      importRecordPath,
      sourceType: "md",
      status: "imported_to_inbox",
      importedAt,
      importMethod,
      converterName: "clipboard-direct",
      converterVersion: "",
      warning: "",
      previewText: content.replace(/\s+/g, " ").trim().slice(0, 1200),
      qualityScore: null
    });

    await this.analyzeImportRecord({
      id: jobId,
      source_file_original_name: `${title}.md`,
      source_file_path: "clipboard://text",
      source_file_stored_path: "",
      output_note_path: outputNotePath,
      output_assets_path: "",
      import_record_path: importRecordPath,
      source_type: "md",
      imported_at: importedAt,
      import_method: importMethod,
      converter_name: "clipboard-direct",
      converter_version: "",
      warning: "",
      preview_text: content.replace(/\s+/g, " ").trim().slice(0, 1200),
      import_status: "imported_to_inbox",
      quality_score: null
    });
    await this.recordFileActivityEvent({
      eventType: "file_imported",
      sourceModule: "import",
      filePath: outputNotePath,
      fileName: path.basename(outputNotePath),
      fileType: "md",
      timestamp: importedAt,
      metadata: {
        importRecordPath,
        importStatus: "imported_to_inbox",
        status: "ready",
        canOpen: true,
        canRelocate: true,
        enteredAt: importedAt,
        sourceFilePath: "clipboard://text",
        sourceFileStoredPath: ""
      }
    });

    await this.activateView();
    await this.refreshInboxViews();
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice("已将剪贴板内容导入到 Inbox。", 5000);
    return { file, notePath: outputNotePath };
  }

  async importClipboardUrl(url, importMethod = "clipboard-content-url") {
    const normalizedUrl = String(url || "").trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      return null;
    }

    let parsedUrl = null;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error("链接格式无效，无法导入。");
    }

    const inboxRoot = normalizePath(this.settings.outputDir || DEFAULT_SETTINGS.outputDir);
    const hostname = parsedUrl.hostname || "网页内容";
    const pageImport = await this.fetchWebPageImportData(normalizedUrl);
    const title = buildUrlImportTitle(normalizedUrl, pageImport.title, hostname);
    const jobId = createJobId();
    const importedAt = getTimestamp();
    const outputNotePath = await getUniqueVaultPath(this.app, `${inboxRoot}/${title}.md`, {
      separator: " "
    });
    const importRecordPath = normalizePath(`${INTERNAL_RECORDS_DIR}/${jobId}.json`);
    const contentLines = [
      `- 来源链接：${normalizedUrl}`,
      `- 来源域名：${hostname}`,
      `- 导入方式：网页内容导入`,
      `- 导入于：${formatImportedAtLine(importedAt)}`
    ];

    if (pageImport.title) {
      contentLines.push(`- 网页标题：${pageImport.title}`);
    }
    if (pageImport.description) {
      contentLines.push(`- 页面摘要：${pageImport.description}`);
    }

    contentLines.push("");

    if (pageImport.description) {
      contentLines.push("## 摘要", "", pageImport.description, "");
    }

    if (pageImport.snippet) {
      contentLines.push("## 正文预览", "", pageImport.snippet, "");
    } else {
      contentLines.push("> 当前阶段已保留来源链接信息，后续可继续增强网页正文抓取与清洗。");
    }

    const content = contentLines.join("\n");

    await ensureFolder(this.app, inboxRoot);
    await ensureFolder(this.app, INTERNAL_RECORDS_DIR);

    const markdown = buildMarkdownDocument({
      title,
      sourceFileName: `${title}.md`,
      sourceFileType: "md",
      sourceFilePath: normalizedUrl,
      sourceFileStoredPath: "",
      importedAt,
      importMethod,
      converterName: "clipboard-url",
      status: "imported_to_inbox",
      outputNotePath,
      outputAssetsPath: "",
      importRecordPath,
      content
    });
    const file = await this.app.vault.create(outputNotePath, markdown);
    await this.saveImportRecord(importRecordPath, {
      id: jobId,
      sourceFileOriginalName: `${title}.md`,
      sourceFilePath: normalizedUrl,
      sourceFileStoredPath: "",
      outputNotePath,
      outputAssetsPath: "",
      importRecordPath,
      sourceType: "md",
      status: "imported_to_inbox",
      importedAt,
      importMethod,
      converterName: "clipboard-url",
      converterVersion: "",
      warning: "",
      previewText: content.replace(/\s+/g, " ").trim().slice(0, 1200),
      qualityScore: null
    });

    await this.recordFileActivityEvent({
      eventType: "file_imported",
      sourceModule: "import",
      filePath: outputNotePath,
      fileName: path.basename(outputNotePath),
      fileType: "md",
      timestamp: importedAt,
      metadata: {
        importRecordPath,
        importStatus: "imported_to_inbox",
        status: "ready",
        canOpen: true,
        canRelocate: true,
        enteredAt: importedAt,
        sourceFilePath: normalizedUrl,
        sourceFileStoredPath: ""
      }
    });

    await this.activateView();
    await this.refreshInboxViews();
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice("已将网页链接导入到 Inbox。", 5000);
    return { file, notePath: outputNotePath };
  }

  async fetchWebPageImportData(url) {
    let html = "";
    try {
      if (typeof requestUrl === "function") {
        const response = await requestUrl({
          url,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 smart-import"
          }
        });
        html = String(response && response.text || "");
      } else {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 smart-import"
          }
        });
        html = await response.text();
      }
    } catch (error) {
      console.warn("Failed to fetch webpage import data", error);
      return {
        title: "",
        description: "",
        snippet: ""
      };
    }

    return {
      title:
        extractHtmlMetaContent(html, "property", "og:title") ||
        extractHtmlMetaContent(html, "name", "twitter:title") ||
        extractHtmlTagContent(html, "title"),
      description:
        extractHtmlMetaContent(html, "property", "og:description") ||
        extractHtmlMetaContent(html, "name", "description") ||
        extractHtmlMetaContent(html, "name", "twitter:description"),
      snippet: extractReadableHtmlSnippet(html)
    };
  }

  async readSystemClipboardText() {
    try {
      const { clipboard } = await getElectronModules();
      if (!clipboard || typeof clipboard.readText !== "function") {
        return "";
      }
      return String(clipboard.readText() || "").trim();
    } catch (error) {
      console.warn("Failed to read system clipboard text", error);
      return "";
    }
  }

  async readSystemClipboardSnapshot() {
    try {
      const { clipboard } = await getElectronModules();
      if (!clipboard) {
        return {
          plainText: "",
          existingPaths: [],
          importablePaths: []
        };
      }

      const rawCandidates = [];
      let plainText = "";
      const pathCandidates = [];
      try {
        plainText = String(clipboard.readText() || "");
        rawCandidates.push(plainText);
      } catch (error) {
        console.warn("Failed to read clipboard text", error);
      }

      if (typeof clipboard.availableFormats === "function") {
        const formats = clipboard.availableFormats();
        for (const format of formats) {
          if (!/(file|uri|filename|text)/i.test(format)) {
            continue;
          }
          try {
            if (typeof clipboard.read === "function") {
              rawCandidates.push(clipboard.read(format));
            }
          } catch {}
          try {
            rawCandidates.push(clipboard.readText(format));
          } catch {}
          try {
            const buffer = clipboard.readBuffer(format);
            if (buffer && buffer.length) {
              rawCandidates.push(buffer.toString("utf8"));
              rawCandidates.push(buffer.toString("utf16le"));
              pathCandidates.push(...(await extractPathsFromClipboardBuffer(buffer)));
            }
          } catch {}
        }
      }

      let clipboardFiles = await this.getClipboardFileCandidates(rawCandidates, pathCandidates);
      if (!clipboardFiles.importablePaths.length && looksLikeClipboardFileName(plainText)) {
        const nameMatchedPaths = await findLocalFilePathsByName(plainText);
        if (nameMatchedPaths.length) {
          const importablePaths = await collectImportablePaths(nameMatchedPaths, {
            maxDepth: 1,
            maxFilesPerDirectory: 20
          });
          clipboardFiles = {
            existingPaths: uniqueStrings([...clipboardFiles.existingPaths, ...nameMatchedPaths]),
            importablePaths: uniqueStrings([...clipboardFiles.importablePaths, ...importablePaths])
          };
        }
      }

      return {
        plainText: String(plainText || "").trim(),
        existingPaths: clipboardFiles.existingPaths,
        importablePaths: clipboardFiles.importablePaths
      };
    } catch (error) {
      console.warn("Failed to build clipboard snapshot", error);
      return {
        plainText: "",
        existingPaths: [],
        importablePaths: []
      };
    }
  }

  async openPasteContentModal(options = {}) {
    const modal = new PasteContentImportModal(this.app, this, options);
    modal.open();
  }

  async importPastedContentValue(value, importMethod = "paste-content-modal") {
    const normalized = String(value || "").trim();
    if (!normalized) {
      throw new Error("没有可导入的内容。");
    }

    const filePaths = uniqueStrings(extractPathsFromArbitraryText(normalized));
    if (filePaths.length) {
      await this.openImportReview(filePaths, `${importMethod}-file`, {
        title: "确认导入本地文件",
        description: "已从粘贴内容中识别出本地文件路径，请确认后继续导入。"
      });
      return { imported: true, mode: "files", paths: filePaths };
    }

    if (/^https?:\/\//i.test(normalized)) {
      return this.importClipboardUrl(normalized, `${importMethod}-url`);
    }

    return this.importClipboardText(normalized, `${importMethod}-text`);
  }

  async importFromClipboardData(dataTransfer, importMethod = "clipboard-paste") {
    const paths = await getDroppedPaths(dataTransfer);
    if (paths.length) {
      await this.openPasteContentModal({
        initialValue: paths.join("\n")
      });
      return { imported: false, mode: "confirm-required" };
    }

    const text = extractClipboardTextValue(dataTransfer);
    if (looksLikeClipboardFileName(text) || looksLikeOnlyFileReferences(text) || !text) {
      const clipboardFiles = await this.getClipboardFileCandidates([text]);
      if (clipboardFiles.importablePaths.length) {
        await this.openPasteContentModal({
          initialValue: clipboardFiles.importablePaths.join("\n"),
          clipboardSnapshot: {
            plainText: String(text || "").trim(),
            existingPaths: clipboardFiles.existingPaths,
            importablePaths: clipboardFiles.importablePaths
          }
        });
        return { imported: false, mode: "confirm-required" };
      }

      if (clipboardFiles.existingPaths.length) {
        new Notice(`已识别到剪贴板中的文件，但当前仅支持 ${SUPPORTED_FILE_TYPES_LABEL}。`, 7000);
        return { imported: false, mode: "unsupported-file" };
      }

      if (looksLikeClipboardFileName(text) || looksLikeOnlyFileReferences(text)) {
        new Notice("识别到了文件名或文件引用，但当前没有拿到可导入的本地文件路径。请改用“选择文件”或“拖拽导入”。", 7000);
        return { imported: false, mode: "paths-only" };
      }
    }

    if (text) {
      await this.openPasteContentModal({
        initialValue: text
      });
      return { imported: false, mode: "confirm-required" };
    }

    new Notice("剪贴板里没有可导入的文件或文本。", 5000);
    return { imported: false, mode: "empty" };
  }

  async importFromSystemClipboard() {
    try {
      const clipboardSnapshot = await this.readSystemClipboardSnapshot();
      const initialValue = clipboardSnapshot.importablePaths.length
        ? clipboardSnapshot.importablePaths.join("\n")
        : clipboardSnapshot.plainText;
      if (!String(initialValue || "").trim()) {
        new Notice("剪贴板里没有可导入的文件或文本。", 5000);
        return { imported: false, mode: "empty" };
      }
      await this.openPasteContentModal({
        initialValue,
        clipboardSnapshot
      });
      return { imported: false, mode: "confirm-required" };
    } catch (error) {
      console.error("Clipboard import failed", error);
      new Notice("剪贴板导入失败，请重试。", 6000);
      return { imported: false, mode: "failed" };
    }
  }

  async importPaths(paths, importMethod, options = {}) {
    if (!Array.isArray(paths) || !paths.length) {
      return { results: [] };
    }

    const conversionExtensions = uniqueStrings(paths.map((filePath) =>
      path.extname(String(filePath || "")).slice(1).toLowerCase()
    )).filter((extension) => SUPPORTED_EXTENSIONS.has(extension) && extension !== "md" && extension !== "txt");

    const environmentResults = [];
    for (const extension of conversionExtensions) {
      environmentResults.push(await this.checkConversionEnvironment(extension));
    }

    const missingEnvironment = environmentResults.find((environment) => !environment.ok);
    if (missingEnvironment) {
      new Notice(`当前无法导入：${missingEnvironment.detail}。已为你打开依赖安装向导。`, 8000);
      await this.activateView();
      await this.refreshInboxViews();
      await this.openDependencyInstallWizard();
      return { results: [] };
    }

    let importedCount = 0;
    let partialCount = 0;
    let failureCount = 0;
    let firstImportedFile = null;
    let firstImportedPath = "";
    const totalCount = paths.length;
    let progressNotice = null;
    const results = [];

    for (let index = 0; index < paths.length; index += 1) {
      const filePath = paths[index];
      progressNotice = showProgressNotice(
        progressNotice,
        `正在导入第 ${index + 1}/${totalCount} 个文件`,
        0
      );

      const result = await this.importExternalFile(filePath, importMethod, options);
      if (result) {
        results.push({
          fileName: path.basename(filePath || ""),
          notePath: result.notePath || "",
          status: result.status || (result.file ? "imported_to_inbox" : "failed"),
          warning: result.warning || "",
          outputAssetsPath: result.outputAssetsPath || ""
        });
      }
      if (result && result.file) {
        if (result.status === "imported_to_inbox") {
          importedCount += 1;
        }
        if (!firstImportedFile) {
          firstImportedFile = result.file;
          firstImportedPath = result.notePath;
        }
      }
      if (result && result.status === "partial_success") {
        partialCount += 1;
      }
      if (!result || result.status === "failed") {
        failureCount += 1;
      }
    }

    await this.activateView();
    await this.refreshInboxViews();

    if (progressNotice && typeof progressNotice.hide === "function") {
      progressNotice.hide();
    }

    if (firstImportedFile) {
      await this.app.workspace.getLeaf(true).openFile(firstImportedFile);
      if (totalCount === 1 && importedCount === 1 && !partialCount && !failureCount && firstImportedPath) {
        new Notice(`已导入到 ${firstImportedPath}`, 6000);
      } else {
        new Notice(`已处理 ${results.length} 个文件：成功 ${importedCount}，部分成功 ${partialCount}，失败 ${failureCount}`, 6000);
      }
    }

    if (results.length > 1 || partialCount || failureCount) {
      new ImportResultSummaryModal(this.app, results, { importMethod }).open();
    }

    return { results };
  }

  async importRecentDownloads() {
    const downloadsPath = path.join(os.homedir(), "Downloads");
    if (!(await pathExists(downloadsPath))) {
      new Notice("未找到 Downloads 文件夹。", 6000);
      return;
    }

    const files = await listRecentFiles(
      downloadsPath,
      SUPPORTED_EXTENSIONS,
      this.settings.recentDownloadsLookbackMinutes || DEFAULT_SETTINGS.recentDownloadsLookbackMinutes
    );

    const fallbackFiles = !files.length
      ? await listSupportedFilesRecursive(downloadsPath, SUPPORTED_EXTENSIONS, {
          maxDepth: 4,
          maxFiles: 100
        })
      : [];
    const candidates = files.length ? files : fallbackFiles.slice(0, 10);

    if (!candidates.length) {
      new Notice(`Downloads 中没有可导入的 ${SUPPORTED_FILE_TYPES_LABEL} 文件。`, 6000);
      return;
    }

    if (!files.length && candidates.length) {
      new Notice(`最近时间范围内没有新文件，已回退到 Downloads 中最近的 ${candidates.length} 个支持文件。`, 6000);
    }

    const selections = await new RecentDownloadsConfirmModal(this.app, candidates, {
      usedFallback: !files.length
    }).openAndGetSelection();

    if (!selections.length) {
      return;
    }

    await this.openImportReview(selections.map((item) => item.path), "recent-downloads", {
      title: "确认导入最近下载",
      description: "请确认最近下载文件的导入范围和保存位置。"
    });
  }

  async selectFiles() {
    try {
      const { dialog } = await getElectronModules();
      if (dialog && typeof dialog.showOpenDialog === "function") {
        const result = await dialog.showOpenDialog({
          title: "选择文件",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "Supported Files",
              extensions: SUPPORTED_EXTENSION_LIST
            },
            {
              name: "All Files",
              extensions: ["*"]
            }
          ]
        });

        if (!result.canceled && Array.isArray(result.filePaths)) {
          return result.filePaths.filter(Boolean);
        }

        return [];
      }
    } catch (error) {
      console.warn("Failed to open native file picker, falling back to browser input", error);
    }

    return this.selectFilesWithBrowserInput();
  }

  selectFilesWithBrowserInput() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = SUPPORTED_FILE_INPUT_ACCEPT;
      input.multiple = true;
      input.style.display = "none";
      let settled = false;

      const cleanup = () => {
        input.removeEventListener("change", handleChange);
        input.removeEventListener("cancel", handleCancel);
        window.removeEventListener("focus", handleFocus, true);
        input.remove();
      };

      const settle = (value) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(value);
      };

      const handleChange = () => {
        const filePaths = Array.from(input.files || [])
          .map((file) => getFilePathFromFileLike(file))
          .filter(Boolean);

        settle(filePaths);
      };

      const handleCancel = () => {
        settle([]);
      };

      const handleFocus = () => {
        window.setTimeout(() => {
          if (!settled && !(input.files && input.files.length)) {
            settle([]);
          }
        }, 0);
      };

      input.addEventListener("change", handleChange);
      input.addEventListener("cancel", handleCancel);
      window.addEventListener("focus", handleFocus, true);
      document.body.appendChild(input);
      input.click();
    });
  }

  async selectDirectory() {
    const { dialog } = await getElectronModules();
    if (!dialog || typeof dialog.showOpenDialog !== "function") {
      throw new Error("当前环境无法打开系统文件夹选择器。");
    }

    const result = await dialog.showOpenDialog({
      title: "选择文件夹",
      properties: ["openDirectory"]
    });

    if (!result.canceled && Array.isArray(result.filePaths) && result.filePaths.length) {
      return result.filePaths[0];
    }
    return "";
  }

  async listImportRecords(options = {}) {
    const recordsDir = this.getAbsoluteVaultPath(INTERNAL_RECORDS_DIR);
    if (!(await pathExists(recordsDir))) {
      return [];
    }

    const entries = await fs.readdir(recordsDir, { withFileTypes: true });
    const records = [];

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
        continue;
      }

      const filePath = path.join(recordsDir, entry.name);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(content);
        parsed.__recordFileName = entry.name;
        parsed.__recordAbsolutePath = filePath;
        records.push(parsed);
      } catch (error) {
        console.warn(`Failed to parse import record: ${entry.name}`, error);
      }
    }

    records.sort((left, right) => {
      const leftTime = new Date(left.imported_at || 0).getTime();
      const rightTime = new Date(right.imported_at || 0).getTime();
      return rightTime - leftTime;
    });

    if (this.settings.enableAiSuggestions && !options.skipAiHydration) {
      const hydrationLimit = Number.isInteger(options.hydrationLimit) ? options.hydrationLimit : 10;
      await Promise.all(
        records.slice(0, hydrationLimit).map(async (record) => {
          const hasAiData =
            record.ai_summary ||
            record.ai_suggested_folder ||
            record.ai_suggested_title ||
            (Array.isArray(record.ai_tags_suggestion) && record.ai_tags_suggestion.length);
          if (!hasAiData) {
            const refreshed = await this.analyzeImportRecord(record);
            Object.assign(record, refreshed);
          }
        })
      );
    }

    return records;
  }

  async saveImportRecord(importRecordPath, record) {
    const normalized = normalizePath(importRecordPath);
    const parent = path.posix.dirname(normalized);
    await ensureFolder(this.app, parent);
    await this.app.vault.adapter.write(normalized, buildImportRecord(record));
    await this.refreshInboxViews();
  }

  getAiProviderConfig() {
    return {
      provider: String(this.settings.aiProvider || "rules"),
      baseUrl: String(this.settings.aiProviderBaseUrl || "").trim() || "https://api.openai.com/v1",
      model: String(this.settings.aiProviderModel || "").trim(),
      apiKey: String(this.settings.aiProviderApiKey || "").trim()
    };
  }

  canUseRemoteAiProvider() {
    const config = this.getAiProviderConfig();
    return Boolean(this.settings.enableAiSuggestions) &&
      config.provider === "openai-compatible" &&
      Boolean(config.model) &&
      Boolean(config.apiKey);
  }

  async correctOcrMarkdownWithAi(markdown) {
    if (!this.canUseRemoteAiProvider()) {
      return markdown;
    }

    const config = this.getAiProviderConfig();
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          messages: buildOcrCorrectionMessages(markdown)
        })
      });

      if (!response.ok) {
        throw new Error(`OCR correction failed: ${response.status}`);
      }

      const payload = await response.json();
      const content =
        payload &&
        payload.choices &&
        payload.choices[0] &&
        payload.choices[0].message &&
        payload.choices[0].message.content;
      const corrected = String(content || "").trim();
      return corrected ? corrected.replace(/\s+$/, "") + "\n" : markdown;
    } catch (error) {
      console.warn("OCR correction via AI provider failed", error);
      return markdown;
    }
  }

  async cleanupMarkdownWithAi(title, markdown) {
    if (!this.settings.enableAiSuggestions || !this.canUseRemoteAiProvider()) {
      return markdown;
    }

    const config = this.getAiProviderConfig();
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          messages: buildMarkdownCleanupMessages(title, markdown)
        })
      });

      if (!response.ok) {
        throw new Error(`Markdown cleanup failed: ${response.status}`);
      }

      const payload = await response.json();
      const content =
        payload &&
        payload.choices &&
        payload.choices[0] &&
        payload.choices[0].message &&
        payload.choices[0].message.content;
      const cleaned = String(content || "")
        .trim()
        .replace(/^```(?:markdown)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      return cleaned ? `${cleaned}\n` : markdown;
    } catch (error) {
      console.warn("Markdown cleanup via AI provider failed", error);
      return markdown;
    }
  }

  async generateAiSuggestionsWithProvider(record) {
    const config = this.getAiProviderConfig();
    if (config.provider !== "openai-compatible") {
      return generateRuleBasedAiSuggestions(record);
    }

    if (!config.model) {
      throw new Error("AI provider 已启用，但尚未填写模型名称。");
    }

    if (!config.apiKey) {
      throw new Error("AI provider 已启用，但尚未填写 API Key。");
    }

    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: buildOpenAiCompatibleMessages(record)
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI provider 请求失败：${response.status} ${errorText}`.trim());
    }

    const payload = await response.json();
    const content =
      payload &&
      payload.choices &&
      payload.choices[0] &&
      payload.choices[0].message &&
      payload.choices[0].message.content;
    const parsed = JSON.parse(extractJsonObject(content));
    return normalizeAiSuggestionResult(parsed, record, "openai-compatible");
  }

  async analyzeImportRecord(record) {
    if (!this.settings.enableAiSuggestions) {
      return record;
    }

    let suggestions;
    let providerError = "";
    try {
      suggestions = await this.generateAiSuggestionsWithProvider(record);
    } catch (error) {
      providerError = error && error.message ? error.message : "AI provider 调用失败。";
      console.warn("AI provider failed, falling back to rules", error);
      suggestions = normalizeAiSuggestionResult(
        {
          ...generateRuleBasedAiSuggestions(record),
          aiFailureExplanation: providerError
        },
        record,
        "rules-fallback"
      );
    }

    const nextRecord = {
      ...record,
      ai_summary: suggestions.aiSummary,
      ai_suggested_title: suggestions.aiSuggestedTitle,
      ai_suggested_folder: suggestions.aiSuggestedFolder,
      ai_tags_suggestion: suggestions.aiTagsSuggestion,
      ai_failure_explanation: suggestions.aiFailureExplanation || providerError || "",
      ai_next_actions: suggestions.aiNextActions,
      ai_provider_used: suggestions.aiProviderUsed || ""
    };

    if (record.import_record_path) {
      await this.saveImportRecord(record.import_record_path, {
        id: nextRecord.id,
        sourceFileOriginalName: nextRecord.source_file_original_name,
        sourceFilePath: nextRecord.source_file_path,
        sourceFileStoredPath: nextRecord.source_file_stored_path,
        outputNotePath: nextRecord.output_note_path,
        outputAssetsPath: nextRecord.output_assets_path,
        importRecordPath: nextRecord.import_record_path,
        sourceType: nextRecord.source_type,
        status: nextRecord.import_status || nextRecord.status,
        importedAt: nextRecord.imported_at,
        importMethod: nextRecord.import_method,
        converterName: nextRecord.converter_name,
        converterVersion: nextRecord.converter_version,
        warning: nextRecord.warning || "",
        previewText: nextRecord.preview_text || "",
        aiSummary: nextRecord.ai_summary || "",
        aiSuggestedFolder: nextRecord.ai_suggested_folder || "",
        aiSuggestedTitle: nextRecord.ai_suggested_title || "",
        aiTagsSuggestion: nextRecord.ai_tags_suggestion || [],
        aiFailureExplanation: nextRecord.ai_failure_explanation || "",
        aiNextActions: nextRecord.ai_next_actions || [],
        aiProviderUsed: nextRecord.ai_provider_used || "",
        qualityScore: nextRecord.quality_score == null ? null : nextRecord.quality_score
      });
    }

    return nextRecord;
  }

  async getImportRecordByNotePath(notePath) {
    const normalized = normalizePath(notePath || "");
    if (!normalized) {
      return null;
    }

    const records = await this.listImportRecords();
    return records.find((record) => normalizePath(record.output_note_path || "") === normalized) || null;
  }

  async getImportRecordByRecordPath(importRecordPath) {
    const normalized = normalizePath(importRecordPath || "");
    if (!normalized) {
      return null;
    }

    const records = await this.listImportRecords();
    return records.find((record) => normalizePath(record.import_record_path || "") === normalized) || null;
  }

  removeImportedNoteChrome() {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    leaves.forEach((leaf) => {
      const container = leaf && leaf.view && leaf.view.containerEl;
      if (!container) {
        return;
      }

      updateImportedNoteContainerClasses(leaf, null, this.settings.importedNoteWidthMode);
      container.querySelectorAll(".smart-import-note-banner").forEach((element) => element.remove());
    });
  }

  async refreshImportedNoteChrome() {
    this.removeImportedNoteChrome();

    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || leaf.view.getViewType() !== "markdown") {
      return;
    }

    const file = typeof leaf.view.getFile === "function" ? leaf.view.getFile() : null;
    if (!file || typeof file.path !== "string") {
      return;
    }

    const record = await this.getImportRecordByNotePath(file.path);
    if (!record) {
      return;
    }

    updateImportedNoteContainerClasses(leaf, record, this.settings.importedNoteWidthMode);

    const target = getImportedNoteBannerHost(leaf);
    const host = target && target.host;
    if (!host) {
      return;
    }

    const banner = createImportedNoteBanner(this, record);
    if (host.querySelector(".smart-import-note-banner")) {
      return;
    }

    if (target.anchor && target.anchor.parentElement === host) {
      target.anchor.insertAdjacentElement("afterend", banner);
      return;
    }

    host.prepend(banner);
  }

  async maybeUpgradeImportedNoteLayout(file) {
    const record = await this.getImportRecordByNotePath(file.path);
    if (!record) {
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const legacyPayload = extractLegacyImportedPayload(content);
    if (!legacyPayload) {
      const hasDuplicateOriginalFileSections = countMarkdownSectionOccurrences(content, "Original File") > 1;
      const hasDuplicateWarningSections = countMarkdownSectionOccurrences(content, "Warnings") > 1;
      if (!hasDuplicateOriginalFileSections && !hasDuplicateWarningSections) {
        return;
      }
      await this.updateImportedNoteMetadata(file, {
        sourceFileName: record.source_file_original_name || path.basename(file.path, path.extname(file.path)),
        sourceFileType: record.source_type || "",
        sourceFileStoredPath: record.source_file_stored_path || "",
        sourceFilePath: record.source_file_path || "",
        importedAt: record.imported_at || "",
        importMethod: record.import_method || "",
        status: record.import_status || record.status || "imported_to_inbox",
        importRecordPath: record.import_record_path || "",
        converterName: record.converter_name || "markitdown",
        warning: record.warning || ""
      });
      return;
    }

    const title = cleanDisplayName(path.basename(file.path, path.extname(file.path)));
    const nextContent = buildMarkdownDocument({
      title,
      sourceFileName: record.source_file_original_name || `${title}.${record.source_type || "md"}`,
      sourceFileType: record.source_type || "",
      sourceFilePath: record.source_file_path || "",
      sourceFileStoredPath: record.source_file_stored_path || "",
      importedAt: record.imported_at || "",
      importMethod: record.import_method || "",
      converterName: record.converter_name || "markitdown",
      status: record.import_status || record.status || "imported_to_inbox",
      outputNotePath: record.output_note_path || file.path,
      outputAssetsPath: record.output_assets_path || "",
      importRecordPath: record.import_record_path || "",
      originalFile: record.source_file_stored_path || "",
      warning: legacyPayload.warning,
      content: legacyPayload.content
    });

    if (nextContent !== content) {
      await this.app.vault.modify(file, nextContent);
    }
  }

  async openNotePath(notePath) {
    if (!notePath) {
      new Notice("当前没有可打开的笔记。", 5000);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
    if (!file || typeof file.path !== "string") {
      new Notice(`未找到笔记：${notePath}`, 5000);
      return;
    }

    await this.openActivityFilePath(file.path);
  }

  async openActivityFilePath(filePath) {
    const normalized = normalizePath(filePath || "");
    if (!normalized) {
      new Notice("当前没有可打开的文件。", 5000);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!file || typeof file.path !== "string") {
      new Notice(`未找到文件：${normalized}`, 5000);
      return;
    }

    try {
      if (path.extname(file.path).toLowerCase() === ".md") {
        await this.maybeUpgradeImportedNoteLayout(file);
      }

      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
      await this.refreshImportedNoteChrome();
      return;
    } catch (error) {
      console.warn("Failed to open activity file in vault view", error);
    }

    const absolutePath = this.getAbsoluteVaultPath(normalized);
    try {
      const { shell } = await getElectronModules();
      if (shell && typeof shell.openPath === "function") {
        const openResult = await shell.openPath(absolutePath);
        if (openResult) {
          throw new Error(openResult);
        }
        return;
      }
    } catch (error) {
      console.warn("Failed to open activity file via shell", error);
    }

    new Notice(`未能直接打开：${normalized}`, 6000);
  }

  async openOriginalFile(record) {
    const preferredPath = record.source_file_stored_path || record.source_file_path || "";
    if (!preferredPath) {
      new Notice("当前没有可查看的原件。", 5000);
      return;
    }

    let absolutePath = preferredPath;
    if (!path.isAbsolute(absolutePath)) {
      absolutePath = this.getAbsoluteVaultPath(preferredPath);
    }

    if (!(await pathExists(absolutePath))) {
      new Notice(`未找到原件：${preferredPath}`, 5000);
      return;
    }

    try {
      const { shell } = await getElectronModules();
      if (shell && typeof shell.openPath === "function") {
        const openResult = await shell.openPath(absolutePath);
        if (openResult) {
          throw new Error(openResult);
        }
        return;
      }
    } catch (error) {
      console.warn("Failed to open original file via shell", error);
    }

    new Notice(`原件路径：${absolutePath}`, 6000);
  }

  async organizeImportedMarkdown(record) {
    if (!record || String(record.source_type || "").toLowerCase() !== "md") {
      new Notice("当前只有 Markdown 导入支持整理。", 5000);
      return { changed: false, record };
    }

    const notePath = normalizePath(record.output_note_path || "");
    if (!notePath) {
      new Notice("当前没有可整理的 Markdown 笔记。", 5000);
      return { changed: false, record };
    }

    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file || typeof file.path !== "string") {
      new Notice("未找到要整理的 Markdown 笔记。", 5000);
      return { changed: false, record };
    }

    const currentContent = await this.app.vault.cachedRead(file);
    const title = cleanDisplayName(path.basename(file.path, path.extname(file.path)));
    const localCleaned = formatImportedMarkdownLocally(title, currentContent);
    const nextContent = await this.cleanupMarkdownWithAi(title, localCleaned || currentContent);

    if (!String(nextContent || "").trim()) {
      new Notice("这篇 Markdown 暂时没有可整理的正文。", 5000);
      return { changed: false, record };
    }

    const normalizedCurrent = String(currentContent || "").replace(/\s+$/, "");
    const normalizedNext = String(nextContent || "").replace(/\s+$/, "");
    if (normalizedCurrent === normalizedNext) {
      new Notice("Markdown 结构已经比较完整，暂时无需整理。", 5000);
      return { changed: false, record };
    }

    await this.app.vault.modify(file, `${normalizedNext}\n`);

    const nextPreviewText = normalizedNext.replace(/\s+/g, " ").trim().slice(0, 1200);
    const nextRecord = {
      ...record,
      preview_text: nextPreviewText
    };

    if (record.import_record_path) {
      await this.saveImportRecord(record.import_record_path, {
        id: nextRecord.id,
        sourceFileOriginalName: nextRecord.source_file_original_name,
        sourceFilePath: nextRecord.source_file_path,
        sourceFileStoredPath: nextRecord.source_file_stored_path,
        outputNotePath: nextRecord.output_note_path,
        outputAssetsPath: nextRecord.output_assets_path,
        importRecordPath: nextRecord.import_record_path,
        sourceType: nextRecord.source_type,
        status: nextRecord.import_status || nextRecord.status,
        importedAt: nextRecord.imported_at,
        importMethod: nextRecord.import_method,
        converterName: nextRecord.converter_name,
        converterVersion: nextRecord.converter_version,
        warning: nextRecord.warning || "",
        previewText: nextRecord.preview_text || "",
        aiSummary: nextRecord.ai_summary || "",
        aiSuggestedFolder: nextRecord.ai_suggested_folder || "",
        aiSuggestedTitle: nextRecord.ai_suggested_title || "",
        aiTagsSuggestion: nextRecord.ai_tags_suggestion || [],
        aiFailureExplanation: nextRecord.ai_failure_explanation || "",
        aiNextActions: nextRecord.ai_next_actions || [],
        aiProviderUsed: nextRecord.ai_provider_used || "",
        qualityScore: nextRecord.quality_score == null ? null : nextRecord.quality_score
      });
    }

    const analyzedRecord = this.settings.enableAiSuggestions
      ? await this.analyzeImportRecord(nextRecord)
      : nextRecord;

    await this.refreshInboxViews();
    await this.refreshImportedNoteChrome();
    new Notice("已整理 Markdown 格式。", 5000);
    return { changed: true, record: analyzedRecord };
  }

  async deleteImportedRecord(record) {
    const notePath = normalizePath(record.output_note_path || "");
    const sourcePath = normalizePath(record.source_file_stored_path || "");
    const assetsPath = normalizePath(record.output_assets_path || "");
    const recordPath = normalizePath(record.import_record_path || "");
    const failures = [];

    const removeTargets = [notePath, sourcePath].filter(Boolean);
    for (const target of removeTargets) {
      const file = this.app.vault.getAbstractFileByPath(target);
      if (!file) {
        continue;
      }

      try {
        await this.app.vault.trash(file, true);
      } catch (error) {
        failures.push(`${target}: ${error && error.message ? error.message : "删除失败"}`);
      }
    }

    if (assetsPath) {
      const assetsFolder = this.app.vault.getAbstractFileByPath(assetsPath);
      try {
        if (assetsFolder) {
          await this.app.vault.trash(assetsFolder, true);
        } else if (await this.app.vault.adapter.exists(assetsPath)) {
          await this.app.vault.adapter.rmdir(assetsPath, true);
        }
      } catch (error) {
        failures.push(`${assetsPath}: ${error && error.message ? error.message : "删除失败"}`);
      }
    }

    if (failures.length) {
      throw new Error(`删除未完成：${failures.join("；")}`);
    }

    if (recordPath && (await this.app.vault.adapter.exists(recordPath))) {
      await this.app.vault.adapter.remove(recordPath);
    }

    await this.removeActivityCards((card) => {
      const cardImportRecordPath = normalizePath(card.metadata && card.metadata.importRecordPath || "");
      const cardFilePath = normalizePath(card.filePath || "");
      return (
        (recordPath && cardImportRecordPath === recordPath) ||
        (notePath && cardFilePath === notePath)
      );
    });

    await this.refreshInboxViews();
    await this.refreshImportedNoteChrome();
  }

  async confirmDeleteRecord(record) {
    if (!this.settings.confirmBeforeDelete) {
      return true;
    }

    return new Promise((resolve) => {
      const modal = new DeleteImportConfirmModal(this.app, this, record, resolve);
      modal.open();
    });
  }

  async retryImport(record) {
    const retryCandidates = [record.source_file_path, record.source_file_stored_path]
      .filter(Boolean)
      .map((candidate) => (path.isAbsolute(candidate) ? candidate : this.getAbsoluteVaultPath(candidate)));

    let sourcePath = "";
    for (const candidate of retryCandidates) {
      if (await pathExists(candidate)) {
        sourcePath = candidate;
        break;
      }
    }

    if (!sourcePath) {
      new Notice("重试失败：已找不到原始文件。", 7000);
      return null;
    }

    return this.importExternalFile(sourcePath, "retry");
  }

  async refreshInboxViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    await Promise.all(
      leaves.map(async (leaf) => {
        if (leaf.view && typeof leaf.view.refresh === "function") {
          await leaf.view.refresh();
        }
      })
    );
  }

  listVisibleFolders() {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((item) => item instanceof TFolder)
      .map((item) => item.path)
      .filter(
        (folderPath) =>
          folderPath &&
          !folderPath.startsWith(".") &&
          folderPath !== "Inbox/_assets" &&
          !folderPath.startsWith("Inbox/_assets/")
      )
      .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  }

  async moveActivityCard(card, targetFolder) {
    const currentPath = normalizePath(card.filePath || card.output_note_path || "");
    if (!currentPath) {
      throw new Error("当前文件路径不可用。");
    }

    if (card.metadata && card.metadata.importRecordPath) {
      const record = await this.getImportRecordByNotePath(currentPath);
      if (record) {
        return this.moveImportedNote(record, targetFolder);
      }
    }

    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (!file || typeof file.path !== "string") {
      throw new Error(`未找到文件：${currentPath}`);
    }

    const normalizedTargetFolder = normalizePath(targetFolder || "");
    if (!normalizedTargetFolder) {
      throw new Error("请选择目标文件夹。");
    }

    if (
      normalizedTargetFolder.startsWith(".") ||
      normalizedTargetFolder === "Inbox/_assets" ||
      normalizedTargetFolder.startsWith("Inbox/_assets/")
    ) {
      throw new Error("不能移动到系统目录或资源目录。");
    }

    await ensureFolder(this.app, normalizedTargetFolder);
    const extension = path.extname(currentPath);
    const baseName = path.basename(currentPath, extension);
    const desiredPath = normalizePath(`${normalizedTargetFolder}/${baseName}${extension}`);
    const nextPath =
      desiredPath === currentPath
        ? currentPath
        : await getUniqueVaultPath(this.app, desiredPath, { separator: " " });

    if (nextPath !== currentPath) {
      await this.app.fileManager.renameFile(file, nextPath);
    }

    await this.recordFileActivityEvent({
      eventType: "file_moved",
      sourceModule: card.sourceModule || "manual",
      filePath: nextPath,
      fileName: path.basename(nextPath),
      fileType: card.fileType || inferActivityFileType(nextPath),
      timestamp: getTimestamp(),
      metadata: {
        ...card.metadata,
        previousFilePath: currentPath,
        enteredAt: card.enteredAt || getTimestamp(),
        status: card.status || "ready",
        canOpen: card.canOpen !== false,
        canRelocate: card.canRelocate !== false
      }
    });

    return nextPath;
  }

  async moveImportedNote(record, targetFolder) {
    const currentPath = normalizePath(record.output_note_path || "");
    if (!currentPath) {
      throw new Error("当前笔记路径不可用。");
    }

    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (!file || typeof file.path !== "string") {
      throw new Error(`未找到笔记：${currentPath}`);
    }

    const normalizedTargetFolder = normalizePath(targetFolder || "");
    if (!normalizedTargetFolder) {
      throw new Error("请选择目标文件夹。");
    }

    if (
      normalizedTargetFolder.startsWith(".") ||
      normalizedTargetFolder === "Inbox/_assets" ||
      normalizedTargetFolder.startsWith("Inbox/_assets/")
    ) {
      throw new Error("不能移动到系统目录或资源目录。");
    }

    await ensureFolder(this.app, normalizedTargetFolder);
    const extension = path.extname(currentPath);
    const baseName = path.basename(currentPath, extension);
    const desiredPath = normalizePath(`${normalizedTargetFolder}/${baseName}${extension}`);
    const nextPath =
      desiredPath === currentPath
        ? currentPath
        : await getUniqueVaultPath(this.app, desiredPath, { separator: " " });

    if (nextPath !== currentPath) {
      await this.app.fileManager.renameFile(file, nextPath);
    }

    const movedFile = this.app.vault.getAbstractFileByPath(nextPath);
    if (movedFile && typeof movedFile.path === "string") {
      await this.updateImportedNoteMetadata(movedFile, {
        outputNotePath: nextPath,
        sourceFileName: record.source_file_original_name || "",
        sourceFileType: record.source_type || "",
        sourceFilePath: record.source_file_path || "",
        sourceFileStoredPath: record.source_file_stored_path || "",
        importedAt: record.imported_at || "",
        importMethod: record.import_method || "",
        converterName: record.converter_name || "",
        status: record.import_status || record.status || "imported_to_inbox",
        importRecordPath: record.import_record_path || "",
        warning: record.warning || ""
      });
    }

    await this.saveImportRecord(record.import_record_path, {
      id: record.id,
      sourceFileOriginalName: record.source_file_original_name,
      sourceFilePath: record.source_file_path,
      sourceFileStoredPath: record.source_file_stored_path,
      outputNotePath: nextPath,
      outputAssetsPath: record.output_assets_path,
      importRecordPath: record.import_record_path,
      sourceType: record.source_type,
      status: record.import_status || record.status,
      importedAt: record.imported_at,
      importMethod: record.import_method,
      converterName: record.converter_name,
      converterVersion: record.converter_version,
      warning: record.warning || "",
      previewText: record.preview_text || "",
      aiSummary: record.ai_summary || "",
      aiSuggestedFolder: record.ai_suggested_folder || "",
      aiSuggestedTitle: record.ai_suggested_title || "",
      aiTagsSuggestion: record.ai_tags_suggestion || [],
      aiFailureExplanation: record.ai_failure_explanation || "",
      aiNextActions: record.ai_next_actions || [],
      aiProviderUsed: record.ai_provider_used || "",
      qualityScore: record.quality_score == null ? null : record.quality_score
    });
    await this.recordFileActivityEvent({
      eventType: "file_moved",
      sourceModule: "import",
      filePath: nextPath,
      fileName: path.basename(nextPath),
      fileType: record.source_type || inferActivityFileType(nextPath),
      timestamp: getTimestamp(),
      metadata: {
        previousFilePath: currentPath,
        importRecordPath: record.import_record_path || "",
        importStatus: record.import_status || record.status || "imported_to_inbox",
        status: record.import_status || record.status || "ready",
        canOpen: (record.import_status || record.status) !== "failed",
        canRelocate: (record.import_status || record.status) !== "failed",
        enteredAt: record.imported_at || getTimestamp(),
        sourceFilePath: record.source_file_path || "",
        sourceFileStoredPath: record.source_file_stored_path || ""
      }
    });

    return nextPath;
  }

  async updateImportedNoteMetadata(file, updates) {
    const content = await this.app.vault.cachedRead(file);
    if (!content) {
      return;
    }

    const nextContentBase = mergeFrontmatterFields(content, buildImportedFrontmatterFields({
      sourceFileName: updates.sourceFileName || path.basename(file.path || "", path.extname(file.path || "")),
      sourceFileType: updates.sourceFileType || path.extname(file.path || "").slice(1).toLowerCase(),
      sourceFileStoredPath: updates.sourceFileStoredPath || "",
      importedAt: updates.importedAt || "",
      importMethod: updates.importMethod || "",
      status: updates.status || "imported_to_inbox",
      importRecordPath: updates.importRecordPath || "",
      converterName: updates.converterName || ""
    }));
    const nextContentWithOriginal = replaceMarkdownSection(
      nextContentBase,
      "Original File",
      buildOriginalFileSectionContent({
        sourceFileStoredPath: updates.sourceFileStoredPath || "",
        sourceFilePath: updates.sourceFilePath || ""
      })
    );
    const nextContent = replaceMarkdownSection(
      nextContentWithOriginal,
      "Warnings",
      buildWarningSectionContent({
        warning: updates.warning || ""
      })
    );

    if (nextContent !== content) {
      await this.app.vault.modify(file, nextContent);
    }
    await this.refreshImportedNoteChrome();
  }

  async importExternalFile(sourcePath, importMethod, options = {}) {
    const fileName = path.basename(sourcePath);
    const extension = path.extname(fileName).slice(1).toLowerCase();
    const isSupported = SUPPORTED_EXTENSIONS.has(extension);
    const isDirectMarkdown = extension === "md";
    const isDirectText = extension === "txt";
    const isLegacyWord = extension === "doc";
    const isEbook = EBOOK_EXTENSIONS.has(extension);
    const needsMarkdownConverter = isSupported && !isDirectMarkdown && !isDirectText;
    const keepOriginal = options.keepOriginal == null ? Boolean(this.settings.keepOriginal) : Boolean(options.keepOriginal);
    const inboxRoot = normalizePath(options.outputDir || this.settings.outputDir || DEFAULT_SETTINGS.outputDir);

    const environment = !needsMarkdownConverter
      ? {
          ok: true,
          command: "",
          version: "",
          detail: ""
        }
      : await this.checkConversionEnvironment(extension, true);
    if (needsMarkdownConverter && !environment.ok) {
      new Notice(`当前无法导入：${environment.detail}。已为你打开依赖安装向导。`, 8000);
      await this.openDependencyInstallWizard();
      return null;
    }

    const assetsRoot = normalizePath(`${inboxRoot}/_assets`);
    const title = path.basename(fileName, path.extname(fileName));
    const cleanedTitle = cleanDisplayName(title);
    const noteBaseName = cleanDisplayName(title);
    const jobId = createJobId();
    const importRecordPath = normalizePath(`${INTERNAL_RECORDS_DIR}/${jobId}.json`);
    const importedAt = getTimestamp();
    const outputNotePath = await getUniqueVaultPath(this.app, `${inboxRoot}/${noteBaseName}.md`, {
      separator: " "
    });
    const baseRecord = {
      id: jobId,
      sourceFileOriginalName: fileName,
      sourceFilePath: sourcePath,
      sourceFileStoredPath: "",
      outputNotePath,
      outputAssetsPath: "",
      importRecordPath,
      sourceType: extension,
      importedAt,
      importMethod,
      converterName: !isSupported
        ? "unsupported-stub"
        : isDirectMarkdown || isDirectText
          ? "direct-copy"
          : isLegacyWord
            ? "libreoffice+markitdown"
            : isEbook
              ? "ebook"
              : "markitdown",
      converterVersion: environment.version,
      warning: "",
      previewText: "",
      qualityScore: null
    };

    await ensureFolder(this.app, inboxRoot);
    await ensureFolder(this.app, INTERNAL_RECORDS_DIR);

    let originalFile = "";
    let originalAbsolutePath = "";
    let tempDir = "";
    let tempMarkdownPath = "";
    let conversionSourcePath = sourcePath;
    if (needsMarkdownConverter || isLegacyWord) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-import-"));
      tempMarkdownPath = path.join(tempDir, `${slugify(cleanedTitle) || "import"}.md`);
    }

    try {
      await this.saveImportRecord(importRecordPath, {
        ...baseRecord,
        status: "received"
      });

      if (keepOriginal) {
        await ensureFolder(this.app, INTERNAL_SOURCE_DIR);
        originalFile = normalizePath(`${INTERNAL_SOURCE_DIR}/${jobId}.${extension}`);
        originalAbsolutePath = this.getAbsoluteVaultPath(originalFile);
        await fs.copyFile(sourcePath, originalAbsolutePath);
      }

      await this.saveImportRecord(importRecordPath, {
        ...baseRecord,
        sourceFileStoredPath: originalFile,
        status: "converting"
      });

      if (!isSupported) {
        const unsupportedWarning = `当前暂不支持该文件类型（.${extension || "unknown"}），已保留原件并生成占位笔记。`;
        const markdown = buildMarkdownDocument({
          title: cleanedTitle,
          sourceFileName: fileName,
          sourceFileType: extension,
          sourceFilePath: sourcePath,
          sourceFileStoredPath: originalFile,
          importedAt,
          importMethod,
          converterName: "unsupported-stub",
          status: "partial_success",
          outputNotePath,
          outputAssetsPath: "",
          importRecordPath,
          warning: unsupportedWarning,
          manualNextStep: "建议先转换为 docx、pdf、pptx、xlsx、md、txt、epub、mobi 或 azw3 后再重试导入。",
          content: ""
        });
        const file = await this.app.vault.create(outputNotePath, markdown);
        await this.saveImportRecord(importRecordPath, {
          ...baseRecord,
          sourceFileStoredPath: originalFile,
          status: "partial_success",
          warning: unsupportedWarning
        });
        await this.analyzeImportRecord({
          id: jobId,
          source_file_original_name: fileName,
          source_file_path: sourcePath,
          source_file_stored_path: originalFile,
          output_note_path: outputNotePath,
          output_assets_path: "",
          import_record_path: importRecordPath,
          source_type: extension,
          imported_at: importedAt,
          import_method: importMethod,
          converter_name: "unsupported-stub",
          converter_version: "",
          warning: unsupportedWarning,
          preview_text: "",
          import_status: "partial_success",
          quality_score: null
        });
        await this.recordFileActivityEvent({
          eventType: "file_imported",
          sourceModule: "import",
          filePath: outputNotePath,
          fileName: path.basename(outputNotePath),
          fileType: extension || inferActivityFileType(outputNotePath),
          timestamp: importedAt,
          metadata: {
            importRecordPath,
            importStatus: "partial_success",
            status: "partial_success",
            canOpen: true,
            canRelocate: true,
            enteredAt: importedAt,
            sourceFilePath: sourcePath,
            sourceFileStoredPath: originalFile,
            warning: unsupportedWarning
          }
        });
        return {
          file,
          notePath: outputNotePath,
          originalFile,
          status: "partial_success",
          warning: unsupportedWarning,
          outputAssetsPath: ""
        };
      }

      if (isLegacyWord) {
        conversionSourcePath = await convertLegacyWordToDocx(sourcePath, tempDir);
      }

      let actualConverterName = isDirectMarkdown || isDirectText ? "direct-copy" : isLegacyWord ? "libreoffice+markitdown" : "markitdown";
      let convertedContent = "";
      if (isDirectMarkdown || isDirectText) {
        convertedContent = await fs.readFile(sourcePath, "utf8");
      } else if (isEbook) {
        const ebookResult = await this.convertEbookToMarkdown(conversionSourcePath, extension, tempDir, environment);
        convertedContent = ebookResult.content;
        actualConverterName = ebookResult.converterName;
      } else {
        convertedContent = await this.convertWithMarkitdown(environment.command, conversionSourcePath, tempMarkdownPath);
      }
      let importStatus = "imported_to_inbox";
      let warning = "";
      let manualNextStep = "";
      let outputAssetsPath = "";
      if (extension === "pdf") {
        const pdfResult = await this.enhancePdfMarkdown(sourcePath, convertedContent, tempDir);
        convertedContent = pdfResult.content;
        importStatus = pdfResult.status;
        warning = pdfResult.warning;
        manualNextStep = pdfResult.manualNextStep;
      } else if (extension === "xls" || extension === "xlsx") {
        convertedContent = cleanSpreadsheetMarkdown(convertedContent);
      }

      if (["docx", "pptx", "xlsx", "doc"].includes(extension)) {
        const assetSlug = slugify(title) || `import-${createJobId()}`;
        const candidateOutputAssetsPath = await getUniqueVaultPath(this.app, `${assetsRoot}/${assetSlug}`, {
          separator: " "
        });
        const candidateAssetsAbsolutePath = this.getAbsoluteVaultPath(candidateOutputAssetsPath);
        const extractedAssets = await extractOfficeMediaAssets(
          isLegacyWord ? conversionSourcePath : sourcePath,
          candidateAssetsAbsolutePath
        );
        if (extractedAssets.length) {
          outputAssetsPath = candidateOutputAssetsPath;
        } else {
          await fs.rm(candidateAssetsAbsolutePath, { recursive: true, force: true }).catch(() => {});
        }
      }

      const previewText = convertedContent.replace(/\s+/g, " ").trim().slice(0, 1200);

      const markdown = buildMarkdownDocument({
        title: cleanedTitle,
        sourceFileName: fileName,
        sourceFileType: extension,
        sourceFilePath: sourcePath,
        sourceFileStoredPath: originalFile,
        importedAt,
        importMethod,
        converterName: actualConverterName,
        status: importStatus,
        outputNotePath,
        outputAssetsPath,
        importRecordPath,
        warning,
        manualNextStep,
        content: convertedContent
      });

      const file = await this.app.vault.create(outputNotePath, markdown);
      const savedRecord = {
        ...baseRecord,
        sourceFileStoredPath: originalFile,
        outputAssetsPath,
        converterName: actualConverterName,
        previewText,
        status: importStatus,
        warning
      };
      await this.saveImportRecord(importRecordPath, savedRecord);
      await this.analyzeImportRecord({
        id: jobId,
        source_file_original_name: fileName,
        source_file_path: sourcePath,
        source_file_stored_path: originalFile,
        output_note_path: outputNotePath,
        output_assets_path: outputAssetsPath,
        import_record_path: importRecordPath,
        source_type: extension,
        imported_at: importedAt,
        import_method: importMethod,
        converter_name: actualConverterName,
        converter_version: environment.version,
        warning,
        preview_text: previewText,
        import_status: importStatus,
        quality_score: null
      });
      await this.recordFileActivityEvent({
        eventType: "file_imported",
        sourceModule: "import",
        filePath: outputNotePath,
        fileName: path.basename(outputNotePath),
        fileType: extension,
        timestamp: importedAt,
        metadata: {
          importRecordPath,
          importStatus: importStatus,
          status: importStatus === "imported_to_inbox" ? "ready" : importStatus,
          canOpen: true,
          canRelocate: true,
          enteredAt: importedAt,
          sourceFilePath: sourcePath,
          sourceFileStoredPath: originalFile,
          warning
        }
      });

      return {
        file,
        notePath: outputNotePath,
        originalFile,
        status: importStatus,
        warning,
        outputAssetsPath
      };
    } catch (error) {
      console.error("Smart import failed", error);
      const detail = (error.stderr || error.message || "Unknown error").trim();
      const markdown = buildMarkdownDocument({
        title: cleanedTitle,
        sourceFileName: fileName,
        sourceFileType: extension,
        sourceFilePath: sourcePath,
        sourceFileStoredPath: originalFile,
        importedAt,
        importMethod,
        converterName: isDirectMarkdown || isDirectText ? "direct-copy" : isLegacyWord ? "libreoffice+markitdown" : isEbook ? "ebook" : "markitdown",
        status: "failed",
        outputNotePath,
        outputAssetsPath: "",
        importRecordPath,
        warning: isDirectMarkdown || isDirectText ? `Import failed: ${detail}` : `Conversion failed: ${detail}`,
        manualNextStep: "请检查依赖环境、原文件可读性，或稍后通过“重试”再次导入。",
        content: ""
      });

      let file = null;
      try {
        file = await this.app.vault.create(outputNotePath, markdown);
      } catch (createError) {
        console.error("Failed to create error note", createError);
      }

      await this.saveImportRecord(importRecordPath, {
        ...baseRecord,
        sourceFileStoredPath: originalFile,
        previewText: "",
        status: "failed",
        warning: detail
      });
      await this.analyzeImportRecord({
        id: jobId,
        source_file_original_name: fileName,
        source_file_path: sourcePath,
        source_file_stored_path: originalFile,
        output_note_path: outputNotePath,
        output_assets_path: "",
        import_record_path: importRecordPath,
        source_type: extension,
        imported_at: importedAt,
        import_method: importMethod,
        converter_name: isDirectMarkdown || isDirectText ? "direct-copy" : isLegacyWord ? "libreoffice+markitdown" : isEbook ? "ebook" : "markitdown",
        converter_version: environment.version,
        warning: detail,
        preview_text: "",
        import_status: "failed",
        quality_score: null
      });
      await this.recordFileActivityEvent({
        eventType: "file_imported",
        sourceModule: "import",
        filePath: outputNotePath,
        fileName: path.basename(outputNotePath),
        fileType: extension,
        timestamp: importedAt,
        metadata: {
          importRecordPath,
          importStatus: "failed",
          status: "failed",
          canOpen: false,
          canRelocate: false,
          canRetry: true,
          enteredAt: importedAt,
          sourceFilePath: sourcePath,
          sourceFileStoredPath: originalFile,
          warning: detail
        }
      });
      new Notice(`导入失败：${fileName}，${summarizeImportErrorForNotice(detail, extension)}`, 8000);
      return {
        file,
        notePath: outputNotePath,
        originalFile,
        status: "failed",
        warning: detail,
        outputAssetsPath: ""
      };
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }
};

class PasteContentImportModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.inputEl = null;
    this.resultEl = null;
    this.previewEl = null;
    this.confirmButton = null;
    this.clipboardSnapshot = null;
    this.urlPreviewToken = 0;
  }

  getAnalysis() {
    const value = String(this.inputEl && this.inputEl.value || "").trim();
    const normalizedTextValue = normalizePastedTextContent(value);
    if (!value) {
      return {
        rawValue: "",
        kind: "empty",
        label: "尚未识别到内容",
        preview: "",
        importMode: "",
        domain: "",
        filePaths: []
      };
    }

    const snapshotPaths = uniqueStrings([
      ...((this.clipboardSnapshot && this.clipboardSnapshot.importablePaths) || []),
      ...((this.clipboardSnapshot && this.clipboardSnapshot.existingPaths) || [])
    ]);

    const directFilePaths = uniqueStrings(extractPathsFromArbitraryText(value));
    const snapshotMatchedPaths = snapshotPaths.filter((candidate) => {
      const basename = path.basename(candidate);
      return value === basename || value.includes(basename);
    });
    const filePaths = directFilePaths.length
      ? directFilePaths
      : snapshotMatchedPaths.length
        ? snapshotMatchedPaths
        : (looksLikeClipboardFileName(value) && snapshotPaths.length ? snapshotPaths : []);

    if (filePaths.length) {
      const firstPath = filePaths[0];
      const firstName = path.basename(firstPath);
      const extension = path.extname(firstPath).slice(1).toLowerCase();
      return {
        rawValue: value,
        kind: "file",
        label: "检测到本地文件",
        preview: firstName,
        importMode: "文件内容导入",
        domain: "",
        filePaths,
        fileTypeLabel: extension.toUpperCase()
      };
    }

    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        return {
          rawValue: value,
          kind: "url",
          label: "检测到网页链接",
          preview: value,
          importMode: "网页内容导入",
          domain: parsed.hostname || "",
          filePaths: []
        };
      } catch {
        // Fall through to text handling.
      }
    }

    const lines = normalizedTextValue
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(0, 4);

    return {
      rawValue: normalizedTextValue,
      kind: "text",
      label: "检测到文本内容",
      preview: lines.join("\n").slice(0, 240),
      importMode: "文本笔记导入",
      domain: "",
      filePaths: []
    };
  }

  renderAnalysis() {
    if (!this.resultEl || !this.previewEl) {
      return;
    }

    this.resultEl.empty();
    this.previewEl.empty();

    const analysis = this.getAnalysis();
    if (this.confirmButton) {
      this.confirmButton.disabled = analysis.kind === "empty";
    }

    if (analysis.kind === "empty") {
      this.resultEl.createEl("p", {
        cls: "smart-import-description smart-import-description--subtle",
        text: "请先粘贴网页链接或文本内容。"
      });
      return;
    }

    this.resultEl.createEl("strong", {
      cls: "smart-import-modal__section-title",
      text: analysis.label
    });

    const card = this.previewEl.createDiv({ cls: "smart-import-preview-card" });
    if (analysis.kind === "file") {
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "文件", analysis.filePaths.map((item) => path.basename(item)).join("、"));
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "类型", analysis.fileTypeLabel || "文件");
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "来源", path.dirname(analysis.filePaths[0] || ""));
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "导入方式", analysis.importMode);
      return;
    }

    if (analysis.kind === "url") {
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "链接", analysis.rawValue);
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "来源", analysis.domain || "未知域名");
      addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "导入方式", analysis.importMode);
      const currentToken = ++this.urlPreviewToken;
      this.plugin.fetchWebPageImportData(analysis.rawValue).then((data) => {
        if (
          currentToken !== this.urlPreviewToken ||
          !this.inputEl ||
          String(this.inputEl.value || "").trim() !== analysis.rawValue
        ) {
          return;
        }

        if (data.title) {
          addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "网页标题", data.title);
        }
        if (data.description) {
          addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "页面摘要", data.description);
        }
      }).catch(() => {});
      return;
    }

    card.createEl("strong", {
      cls: "smart-import-modal__section-title",
      text: "预览"
    });
    card.createEl("pre", {
      cls: "smart-import-preview-card__text",
      text: analysis.preview || analysis.rawValue.slice(0, 240)
    });
    addInfoRow(card.createDiv({ cls: "smart-import-modal__info" }), "导入方式", analysis.importMode);
  }

  onClose() {
    this.contentEl.empty();
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");
    contentEl.addClass("smart-import-paste-content-modal");

    contentEl.createEl("h2", { text: "粘贴内容导入" });
    contentEl.createEl("p", {
      cls: "smart-import-description",
      text: "系统会先识别剪贴板里的链接或文本，并在确认后再导入。"
    });

    const field = contentEl.createDiv({ cls: "smart-import-modal__field" });
    field.createEl("label", { text: "输入内容" });
    this.inputEl = field.createEl("textarea", {
      cls: "smart-import-paste-content-modal__input",
      attr: {
        placeholder: "粘贴网页链接、文章内容或选中的文本"
      }
    });

    this.resultEl = contentEl.createDiv({ cls: "smart-import-paste-content-modal__result" });
    this.previewEl = contentEl.createDiv({ cls: "smart-import-paste-content-modal__preview" });

    contentEl.createEl("p", {
      cls: "smart-import-description smart-import-description--subtle",
      text: "确认后将导入到 Inbox"
    });

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);
    this.confirmButton = actions.createEl("button", { text: "确认导入" });
    const clearButton = actions.createEl("button", { text: "清空重填" });
    const cancelButton = actions.createEl("button", { text: "取消" });
    this.confirmButton.classList.add("smart-import-primary-button");
    clearButton.classList.add("smart-import-secondary-button");
    cancelButton.classList.add("smart-import-secondary-button");
    styleActionButton(this.confirmButton, "primary");
    styleActionButton(clearButton, "secondary");
    styleActionButton(cancelButton, "secondary");

    this.inputEl.addEventListener("input", () => {
      this.renderAnalysis();
    });

    clearButton.addEventListener("click", () => {
      if (this.inputEl) {
        this.inputEl.value = "";
        this.inputEl.focus();
      }
      this.renderAnalysis();
    });

    cancelButton.addEventListener("click", () => {
      this.close();
    });

    this.confirmButton.addEventListener("click", async () => {
      const analysis = this.getAnalysis();
      if (analysis.kind === "empty") {
        new Notice("请先输入要导入的内容。", 5000);
        return;
      }

      this.confirmButton.disabled = true;
      try {
        if (analysis.kind === "file" && Array.isArray(analysis.filePaths) && analysis.filePaths.length) {
          await this.plugin.openImportReview(analysis.filePaths, "paste-content-modal-file", {
            title: "确认导入本地文件",
            description: "已从粘贴内容中识别出本地文件，请确认后继续导入。"
          });
        } else {
          await this.plugin.importPastedContentValue(analysis.rawValue, "paste-content-modal");
        }
        this.close();
      } catch (error) {
        const message = error && error.message ? error.message : "粘贴内容导入失败。";
        new Notice(message, 6000);
      } finally {
        this.confirmButton.disabled = false;
      }
    });

    this.clipboardSnapshot = this.options.clipboardSnapshot || await this.plugin.readSystemClipboardSnapshot();
    const initialValue = String(
      this.options.initialValue ||
      (this.clipboardSnapshot.importablePaths.length
        ? this.clipboardSnapshot.importablePaths.join("\n")
        : this.clipboardSnapshot.plainText)
    ).trim();
    if (initialValue && this.inputEl) {
      this.inputEl.value = initialValue;
    }

    this.renderAnalysis();
    if (this.inputEl) {
      this.inputEl.focus();
    }
  }
}

class ImportReviewModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.entries = Array.isArray(options.entries) ? options.entries : [];
    this.selectedPaths = new Set(this.entries.map((entry) => entry.path).filter(Boolean));
    this.targetInput = null;
    this.keepOriginalCheckbox = null;
    this.onDecision = null;
  }

  openAndImport() {
    return new Promise((resolve) => {
      this.onDecision = resolve;
      this.open();
    });
  }

  finish(result) {
    if (typeof this.onDecision === "function") {
      this.onDecision(result);
      this.onDecision = null;
    }
    this.close();
  }

  onClose() {
    if (this.onDecision) {
      this.onDecision({ imported: false, reason: "cancelled" });
      this.onDecision = null;
    }
    this.contentEl.empty();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    const sortedEntries = [...this.entries].sort((left, right) => {
      if (left.supported !== right.supported) {
        return left.supported ? -1 : 1;
      }
      return path.basename(left.path || "").localeCompare(path.basename(right.path || ""), "zh-Hans-CN");
    });
    const supportedCount = sortedEntries.filter((entry) => entry.supported).length;
    const unsupportedCount = sortedEntries.length - supportedCount;
    const folderOptions = this.plugin.listVisibleFolders();

    contentEl.createEl("h2", { text: this.options.title || "确认导入" });
    contentEl.createEl("p", {
      cls: "smart-import-description",
      text: this.options.description || "确认文件范围、保存目录和原件保留策略后再开始导入。"
    });

    const summary = contentEl.createDiv({ cls: "smart-import-preview-card" });
    addInfoRow(summary.createDiv({ cls: "smart-import-modal__info" }), "导入方式", formatImportMethodLabel(this.options.importMethod));
    addInfoRow(summary.createDiv({ cls: "smart-import-modal__info" }), "识别文件", String(sortedEntries.length));
    addInfoRow(summary.createDiv({ cls: "smart-import-modal__info" }), "支持格式", String(supportedCount));
    if (unsupportedCount) {
      addInfoRow(summary.createDiv({ cls: "smart-import-modal__info" }), "占位导入", `${unsupportedCount} 个`);
    }

    const locationField = contentEl.createDiv({ cls: "smart-import-modal__field" });
    locationField.createEl("label", { text: "目标文件夹" });
    this.targetInput = locationField.createEl("input", {
      type: "text",
      value: normalizePath(this.options.outputDir || this.plugin.settings.outputDir || DEFAULT_SETTINGS.outputDir),
      placeholder: "Inbox"
    });
    const folderList = locationField.createEl("datalist", {
      attr: { id: `smart-import-folders-${Date.now()}` }
    });
    folderOptions.forEach((folderPath) => {
      folderList.createEl("option", { value: folderPath });
    });
    this.targetInput.setAttribute("list", folderList.id);

    const keepField = contentEl.createDiv({ cls: "smart-import-modal__field" });
    const keepWrapper = keepField.createDiv({ cls: "smart-import-info-row" });
    this.keepOriginalCheckbox = keepWrapper.createEl("input", { type: "checkbox" });
    this.keepOriginalCheckbox.checked = this.options.keepOriginal == null
      ? Boolean(this.plugin.settings.keepOriginal)
      : Boolean(this.options.keepOriginal);
    keepWrapper.createEl("span", { text: "保留原件到 .openclaw/source-files/" });

    const list = contentEl.createDiv({ cls: "smart-import-recent-list" });
    sortedEntries.forEach((entry) => {
      const row = list.createDiv({ cls: "smart-import-recent-item" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedPaths.has(entry.path);
      const body = row.createDiv({ cls: "smart-import-recent-item__body" });
      body.createEl("strong", { text: path.basename(entry.path || "") || "未命名文件" });
      body.createEl("div", {
        cls: "smart-import-recent-item__meta",
        text: `${entry.supported ? "支持导入" : "生成占位笔记"} · ${formatSourceType(entry.extension)}`
      });
      body.createEl("div", {
        cls: "smart-import-recent-item__path",
        text: path.dirname(entry.path || "")
      });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectedPaths.add(entry.path);
        } else {
          this.selectedPaths.delete(entry.path);
        }
      });
    });

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);
    const cancelButton = actions.createEl("button", { text: "取消" });
    const confirmButton = actions.createEl("button", { text: "确认导入" });
    cancelButton.classList.add("smart-import-secondary-button");
    confirmButton.classList.add("smart-import-primary-button");
    styleActionButton(cancelButton, "secondary");
    styleActionButton(confirmButton, "primary");

    cancelButton.addEventListener("click", () => {
      this.finish({ imported: false, reason: "cancelled" });
    });

    confirmButton.addEventListener("click", async () => {
      const selectedPaths = sortedEntries
        .map((entry) => entry.path)
        .filter((candidate) => this.selectedPaths.has(candidate));
      if (!selectedPaths.length) {
        new Notice("请至少勾选一个文件。", 5000);
        return;
      }

      const outputDir = normalizePath(String(this.targetInput && this.targetInput.value || "").trim() || DEFAULT_SETTINGS.outputDir);
      if (
        !outputDir ||
        outputDir.startsWith(".") ||
        outputDir === "Inbox/_assets" ||
        outputDir.startsWith("Inbox/_assets/")
      ) {
        new Notice("请选择一个可见业务目录，不能使用系统目录或资源目录。", 6000);
        return;
      }
      confirmButton.disabled = true;
      try {
        const result = await this.plugin.importPaths(selectedPaths, this.options.importMethod, {
          outputDir,
          keepOriginal: Boolean(this.keepOriginalCheckbox && this.keepOriginalCheckbox.checked)
        });
        this.finish({ imported: true, result });
      } catch (error) {
        const message = error && error.message ? error.message : "导入失败。";
        new Notice(message, 7000);
      } finally {
        confirmButton.disabled = false;
      }
    });
  }
}

class SmartImportRequestModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.inputEl = null;
    this.previewEl = null;
  }

  renderPreview() {
    if (!this.previewEl) {
      return;
    }

    this.previewEl.empty();
    const query = String(this.inputEl && this.inputEl.value || "").trim();
    if (!query) {
      this.previewEl.createEl("p", {
        cls: "smart-import-description smart-import-description--subtle",
        text: "例如：导入我今天下载的预算 ppt，或导入桌面上那个产品说明 pdf。"
      });
      return;
    }

    const parsed = this.plugin.parseSmartImportRequest(query);
    addInfoRow(this.previewEl.createDiv({ cls: "smart-import-modal__info" }), "关键词", parsed.keywords.join("、") || "未识别");
    addInfoRow(this.previewEl.createDiv({ cls: "smart-import-modal__info" }), "文件类型", parsed.fileTypes.join("、") || "未限定");
    addInfoRow(this.previewEl.createDiv({ cls: "smart-import-modal__info" }), "优先最近", parsed.preferRecent ? "是" : "否");
    addInfoRow(this.previewEl.createDiv({ cls: "smart-import-modal__info" }), "Finder 当前选中", parsed.wantsFinder ? "是" : "否");
    addInfoRow(this.previewEl.createDiv({ cls: "smart-import-modal__info" }), "剪贴板候选", parsed.wantsClipboard ? "是" : "否");
  }

  onClose() {
    this.contentEl.empty();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    contentEl.createEl("h2", { text: "自然语言导入" });
    contentEl.createEl("p", {
      cls: "smart-import-description",
      text: "用自然语言描述你想导入的文件，系统会先检索候选，再进入确认导入界面。"
    });

    const field = contentEl.createDiv({ cls: "smart-import-modal__field" });
    field.createEl("label", { text: "导入请求" });
    this.inputEl = field.createEl("textarea", {
      cls: "smart-import-paste-content-modal__input",
      attr: {
        placeholder: "例如：导入我今天下载的预算 ppt"
      }
    });

    this.previewEl = contentEl.createDiv({ cls: "smart-import-paste-content-modal__preview" });

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);
    const cancelButton = actions.createEl("button", { text: "取消" });
    const searchButton = actions.createEl("button", { text: "检索候选" });
    cancelButton.classList.add("smart-import-secondary-button");
    searchButton.classList.add("smart-import-primary-button");
    styleActionButton(cancelButton, "secondary");
    styleActionButton(searchButton, "primary");

    this.inputEl.addEventListener("input", () => {
      this.renderPreview();
    });

    cancelButton.addEventListener("click", () => {
      this.close();
    });

    searchButton.addEventListener("click", async () => {
      const query = String(this.inputEl && this.inputEl.value || "").trim();
      if (!query) {
        new Notice("请先输入导入请求。", 5000);
        return;
      }

      searchButton.disabled = true;
      try {
        const candidates = await this.plugin.searchSmartImportRequest(query);
        if (!candidates.length) {
          new Notice("没有找到匹配的本地文件候选。", 6000);
          return;
        }

        await this.plugin.openImportReview(candidates, "smart-request", {
          title: "确认自然语言导入候选",
          description: `系统已根据“${query}”检索到候选文件，请确认后继续导入。`
        });
        this.close();
      } finally {
        searchButton.disabled = false;
      }
    });

    this.renderPreview();
    this.inputEl.focus();
  }
}

class ImportResultSummaryModal extends Modal {
  constructor(app, results, options = {}) {
    super(app);
    this.results = Array.isArray(results) ? results : [];
    this.options = options;
  }

  onClose() {
    this.contentEl.empty();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    const successCount = this.results.filter((item) => item.status === "imported_to_inbox").length;
    const partialCount = this.results.filter((item) => item.status === "partial_success").length;
    const failureCount = this.results.filter((item) => item.status === "failed").length;

    contentEl.createEl("h2", { text: "导入结果摘要" });
    addInfoRow(contentEl.createDiv({ cls: "smart-import-modal__info" }), "导入方式", formatImportMethodLabel(this.options.importMethod));
    addInfoRow(contentEl.createDiv({ cls: "smart-import-modal__info" }), "成功", String(successCount));
    addInfoRow(contentEl.createDiv({ cls: "smart-import-modal__info" }), "部分成功", String(partialCount));
    addInfoRow(contentEl.createDiv({ cls: "smart-import-modal__info" }), "失败", String(failureCount));

    const list = contentEl.createDiv({ cls: "smart-import-recent-list" });
    this.results.forEach((item) => {
      const row = list.createDiv({ cls: "smart-import-recent-item" });
      const body = row.createDiv({ cls: "smart-import-recent-item__body" });
      const meta = getStatusMeta(item.status || "");
      body.createEl("strong", { text: item.fileName || path.basename(item.notePath || "") || "未命名文件" });
      body.createEl("div", {
        cls: "smart-import-recent-item__meta",
        text: `状态：${meta.label}`
      });
      if (item.notePath) {
        body.createEl("div", {
          cls: "smart-import-recent-item__path",
          text: item.notePath
        });
      }
      if (item.warning) {
        body.createEl("div", {
          cls: "smart-import-description smart-import-description--subtle",
          text: item.warning
        });
      }
    });

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);
    const closeButton = actions.createEl("button", { text: "关闭" });
    closeButton.classList.add("smart-import-primary-button");
    styleActionButton(closeButton, "primary");
    closeButton.addEventListener("click", () => {
      this.close();
    });
  }
}

class SmartImportInboxView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.recordsEl = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "文件管理";
  }

  async onOpen() {
    await this.render();
  }

  async refresh() {
    await this.render();
  }

  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("smart-import-view");
    const records = await this.plugin.listActivityCards(this.plugin.settings.activitySortMode);
    const sourceCount = new Set(records.map((record) => String(record.sourceModule || "unknown"))).size;

    const hero = container.createDiv({ cls: "smart-import-hero" });
    hero.createEl("h2", { text: "文件管理" });
    const lead = hero.createEl("p", {
      text: "平台内有业务意义的文件活动会统一显示在这里。"
    });
    lead.addClass("smart-import-description");
    const subLead = hero.createEl("p", {
      text: "导入、研究导出和业务文件变动都会进入活动流；用户可见默认落点仍为 Inbox。"
    });
    subLead.addClass("smart-import-description");
    subLead.addClass("smart-import-description--subtle");
    const heroMeta = hero.createDiv({ cls: "smart-import-hero__meta" });
    heroMeta.createEl("span", { text: `活动卡片 ${records.length}` });
    heroMeta.createEl("span", { text: `来源模块 ${sourceCount}` });
    heroMeta.createEl("span", { text: "默认落点 Inbox" });

    container.createEl("h3", { cls: "smart-import-section-title", text: "新建入口" });
    const actions = container.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);
    const importButton = actions.createEl("button", { text: "选择文件" });
    const folderButton = actions.createEl("button", { text: "导入文件夹" });
    const finderButton = actions.createEl("button", { text: "Finder 当前选中" });
    const pasteButton = actions.createEl("button", { text: "粘贴内容" });
    const recentButton = actions.createEl("button", { text: "最近下载" });
    const requestButton = actions.createEl("button", { text: "自然语言导入" });
    const rebuildButton = actions.createEl("button", { text: "重建活动流" });
    const refreshButton = actions.createEl("button", { text: "刷新" });
    importButton.classList.add("smart-import-primary-button");
    folderButton.classList.add("smart-import-secondary-button");
    finderButton.classList.add("smart-import-secondary-button");
    pasteButton.classList.add("smart-import-secondary-button");
    recentButton.classList.add("smart-import-secondary-button");
    requestButton.classList.add("smart-import-secondary-button");
    rebuildButton.classList.add("smart-import-secondary-button");
    refreshButton.classList.add("smart-import-secondary-button");
    styleActionButton(importButton, "primary");
    styleActionButton(folderButton, "secondary");
    styleActionButton(finderButton, "secondary");
    styleActionButton(pasteButton, "secondary");
    styleActionButton(recentButton, "secondary");
    styleActionButton(requestButton, "secondary");
    styleActionButton(rebuildButton, "secondary");
    styleActionButton(refreshButton, "secondary");

    importButton.addEventListener("click", async () => {
      importButton.disabled = true;
      try {
        await this.plugin.openFilePicker();
      } finally {
        importButton.disabled = false;
        await this.refresh();
      }
    });

    folderButton.addEventListener("click", async () => {
      folderButton.disabled = true;
      try {
        await this.plugin.openFolderPicker();
      } finally {
        folderButton.disabled = false;
        await this.refresh();
      }
    });

    finderButton.addEventListener("click", async () => {
      finderButton.disabled = true;
      try {
        await this.plugin.importFinderSelection();
      } finally {
        finderButton.disabled = false;
        await this.refresh();
      }
    });

    pasteButton.addEventListener("click", async () => {
      pasteButton.disabled = true;
      try {
        await this.plugin.openPasteContentModal();
      } finally {
        pasteButton.disabled = false;
      }
    });

    recentButton.addEventListener("click", async () => {
      recentButton.disabled = true;
      try {
        await this.plugin.importRecentDownloads();
      } finally {
        recentButton.disabled = false;
        await this.refresh();
      }
    });

    requestButton.addEventListener("click", async () => {
      requestButton.disabled = true;
      try {
        await this.plugin.openSmartRequestModal();
      } finally {
        requestButton.disabled = false;
      }
    });

    rebuildButton.addEventListener("click", async () => {
      rebuildButton.disabled = true;
      try {
        new Notice("正在重建活动流…", 4000);
        await this.plugin.rebuildActivityStore();
        new Notice("活动流已重建。", 5000);
      } finally {
        rebuildButton.disabled = false;
        await this.refresh();
      }
    });

    refreshButton.addEventListener("click", async () => {
      await this.refresh();
    });

    container.createEl("h3", { cls: "smart-import-section-title", text: "快捷接入" });
    const entryGrid = container.createDiv({ cls: "smart-import-entry-grid" });
    const dropzone = entryGrid.createDiv({ cls: "smart-import-dropzone" });
    dropzone.createEl("strong", { text: "拖拽导入" });
    dropzone.createEl("p", { text: "把文件或文件夹拖到这里，系统会先展示导入确认信息，再开始导入。" });

    const setDropzoneState = (active) => {
      dropzone.toggleClass("is-active", active);
    };

    const handleDragOver = (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      setDropzoneState(true);
    };

    const handleDragLeave = (event) => {
      event.preventDefault();
      if (!dropzone.contains(event.relatedTarget)) {
        setDropzoneState(false);
      }
    };

    const handleDrop = async (event) => {
      event.preventDefault();
      setDropzoneState(false);
      const paths = await getDroppedPaths(event.dataTransfer);

      if (!paths.length) {
        new Notice(`没有识别到可导入的本地文件，请直接拖入文件本身，或拖入包含 ${SUPPORTED_FILE_EXTENSIONS_LABEL} 的文件夹。`, 6000);
        return;
      }

      await this.plugin.openImportReview(paths, "drag-drop", {
        title: "确认拖拽导入",
        description: "拖入的文件和文件夹已识别完成，请确认后继续导入。"
      });
      await this.refresh();
    };

    dropzone.addEventListener("dragover", handleDragOver);
    dropzone.addEventListener("dragenter", handleDragOver);
    dropzone.addEventListener("dragleave", handleDragLeave);
    dropzone.addEventListener("drop", handleDrop);

    const recordsHeader = container.createDiv({ cls: "smart-import-records-header" });
    recordsHeader.createEl("strong", { text: "最近文件活动" });
    const sortSelect = recordsHeader.createEl("select");
    sortSelect.add(new Option("最近进入", "recent_entered"));
    sortSelect.add(new Option("最近编辑", "recent_edited"));
    sortSelect.value = normalizeActivitySortMode(this.plugin.settings.activitySortMode);
    sortSelect.addEventListener("change", async () => {
      this.plugin.settings.activitySortMode = normalizeActivitySortMode(sortSelect.value);
      await this.plugin.saveSettings();
      await this.refresh();
    });

    this.recordsEl = container.createDiv({ cls: "smart-import-records" });
    this.renderRecords(records);
  }

  renderRecords(records) {
    if (!this.recordsEl) {
      return;
    }

    this.recordsEl.empty();
    if (!records.length) {
      const empty = this.recordsEl.createDiv({ cls: "smart-import-empty" });
      empty.createEl("p", { text: "还没有文件活动。" });
      empty.createEl("p", { text: "导入、研究导出或新增业务文件后，会显示在这里。" });
      return;
    }

    records.forEach((record) => {
      const card = this.recordsEl.createDiv({ cls: "smart-import-card" });
      const header = card.createDiv({ cls: "smart-import-card__header" });
      const titleEl = header.createEl("strong", { text: getDisplayNameFromRecord(record) });
      titleEl.addClass("smart-import-card__title");

      const isFailure = String(record.status || "") === "failed";
      const canOpen = Boolean(record.canOpen) && !isFailure;
      const canRelocate = Boolean(record.canRelocate) && !isFailure;
      const canRetry = isFailure && Boolean(record.metadata && record.metadata.importRecordPath);
      const canDelete = Boolean(record.metadata && record.metadata.importRecordPath);
      const canViewOriginal = Boolean(
        record.metadata &&
        [record.metadata.sourceFileStoredPath, record.metadata.sourceFilePath]
          .filter(Boolean)
          .some((candidate) => !String(candidate).startsWith("clipboard://"))
      );

      if (canRetry) {
        const retryButton = header.createEl("button", { text: "重试" });
        retryButton.classList.add("smart-import-secondary-button");
        styleActionButton(retryButton, "secondary");
        retryButton.addEventListener("click", async () => {
          retryButton.disabled = true;
          try {
            const importRecord = await this.plugin.getImportRecordByRecordPath(record.metadata.importRecordPath);
            if (!importRecord) {
              throw new Error("未找到失败记录，无法重试。");
            }
            await this.plugin.retryImport(importRecord);
            await this.refresh();
          } catch (error) {
            const message = error && error.message ? error.message : "重试失败。";
            new Notice(message, 6000);
          } finally {
            retryButton.disabled = false;
          }
        });
      }

      if (canOpen) {
        const primaryAction = header.createEl("button", { text: "打开笔记" });
        primaryAction.classList.add("smart-import-secondary-button");
        styleActionButton(primaryAction, "secondary");
        primaryAction.addEventListener("click", async () => {
          primaryAction.disabled = true;
          try {
            await this.plugin.openActivityFilePath(record.filePath);
          } finally {
            primaryAction.disabled = false;
          }
        });
      }

      const metaLine = card.createDiv({ cls: "smart-import-card__meta" });
      metaLine.setText(`来自 ${getActivitySourceLabel(record.sourceModule)} · ${formatImportedAtCompact(record.enteredAt)}`);

      const locationLine = card.createDiv({ cls: "smart-import-card__location" });
      const importStatus = String(record.metadata && record.metadata.importStatus || record.status || "imported_to_inbox");
      const statusMeta = getStatusMeta(importStatus);
      locationLine.setText(`状态：${statusMeta.label} · ${isFailure ? "导入失败" : `位置：${record.locationLabel || getDisplayFolder(record)}`}`);

      const warningText = String(record.metadata && record.metadata.warning || "").trim();
      if (warningText) {
        card.createEl("div", {
          cls: "smart-import-description smart-import-description--subtle",
          text: warningText
        });
      }

      const actions = card.createDiv({ cls: "smart-import-card__actions" });
      makeVisibleActionRow(actions);
      actions.style.marginBottom = "0";

      if (canRelocate) {
        const adjustButton = actions.createEl("button", { text: "调整位置" });
        adjustButton.classList.add("smart-import-secondary-button");
        styleActionButton(adjustButton, "secondary");
        adjustButton.addEventListener("click", async () => {
          const modal = new AdjustSaveLocationModal(this.app, this.plugin, record, async () => {
            await this.refresh();
          });
          modal.open();
        });
      }

      if (canViewOriginal) {
        const originalButton = actions.createEl("button", { text: "查看原件" });
        originalButton.classList.add("smart-import-secondary-button");
        styleActionButton(originalButton, "secondary");
        originalButton.addEventListener("click", async () => {
          originalButton.disabled = true;
          try {
            const importRecord = record.metadata && record.metadata.importRecordPath
              ? await this.plugin.getImportRecordByRecordPath(record.metadata.importRecordPath)
              : null;

            if (importRecord) {
              await this.plugin.openOriginalFile(importRecord);
            } else {
              await this.plugin.openOriginalFile({
                source_file_stored_path: record.metadata && record.metadata.sourceFileStoredPath || "",
                source_file_path: record.metadata && record.metadata.sourceFilePath || ""
              });
            }
          } catch (error) {
            const message = error && error.message ? error.message : "打开原件失败。";
            new Notice(message, 6000);
          } finally {
            originalButton.disabled = false;
          }
        });
      }

      if (canDelete) {
        const deleteButton = actions.createEl("button", { text: "删除" });
        deleteButton.classList.add("smart-import-secondary-button");
        styleActionButton(deleteButton, "secondary");
        deleteButton.addEventListener("click", async () => {
          deleteButton.disabled = true;
          try {
            const importRecord = await this.plugin.getImportRecordByRecordPath(record.metadata.importRecordPath);
            if (!importRecord) {
              await this.plugin.removeActivityCards((card) => {
                const cardImportRecordPath = normalizePath(card.metadata && card.metadata.importRecordPath || "");
                const cardFilePath = normalizePath(card.filePath || "");
                return (
                  cardImportRecordPath === normalizePath(record.metadata.importRecordPath || "") ||
                  cardFilePath === normalizePath(record.filePath || "")
                );
              });
              new Notice("原文件已不存在，已移除失效卡片。", 5000);
              await this.refresh();
              return;
            }

            const confirmed = await this.plugin.confirmDeleteRecord(importRecord);
            if (!confirmed) {
              return;
            }

            await this.plugin.deleteImportedRecord(importRecord);
            new Notice("已删除导入记录与笔记。", 5000);
            await this.refresh();
          } catch (error) {
            const message = error && error.message ? error.message : "删除失败。";
            new Notice(message, 6000);
          } finally {
            deleteButton.disabled = false;
          }
        });
      }
    });
  }
}

class AdjustSaveLocationModal extends Modal {
  constructor(app, plugin, record, onMoved) {
    super(app);
    this.plugin = plugin;
    this.record = record;
    this.onMoved = onMoved;
    this.targetInput = null;
    this.folderSearchInput = null;
    this.folderListEl = null;
    this.availableFolders = [];
    this.selectedFolder = "";
  }

  renderFolderOptions() {
    if (!this.folderListEl) {
      return;
    }

    this.folderListEl.empty();
    const keyword = String(this.folderSearchInput && this.folderSearchInput.value || "").trim().toLowerCase();
    const filteredFolders = this.availableFolders.filter((folderPath) => {
      if (!keyword) {
        return true;
      }
      return folderPath.toLowerCase().includes(keyword);
    });

    if (!filteredFolders.length) {
      this.folderListEl.createEl("p", {
        cls: "smart-import-folder-picker__empty",
        text: "没有匹配的文件夹。可以直接在下方输入新路径。"
      });
      return;
    }

    filteredFolders.forEach((folderPath) => {
      const option = this.folderListEl.createEl("button", {
        cls: "smart-import-folder-picker__option",
        text: folderPath
      });
      option.type = "button";
      if (folderPath === this.selectedFolder) {
        option.addClass("is-selected");
      }
      option.addEventListener("click", () => {
        this.selectedFolder = folderPath;
        if (this.targetInput) {
          this.targetInput.value = folderPath;
        }
        this.renderFolderOptions();
      });
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    contentEl.createEl("h2", { text: "调整保存位置" });
    addInfoRow(contentEl.createDiv({ cls: "smart-import-modal__info" }), "当前文件", getDisplayNameFromRecord(this.record));
    addInfoRow(contentEl.createDiv({ cls: "smart-import-modal__info" }), "当前保存位置", getDisplayFolder(this.record));
    if (this.record.ai_suggested_folder) {
      addInfoRow(
        contentEl.createDiv({ cls: "smart-import-modal__info" }),
        "建议位置",
        this.record.ai_suggested_folder
      );
    }
    if (Array.isArray(this.record.ai_tags_suggestion) && this.record.ai_tags_suggestion.length) {
      addInfoRow(
        contentEl.createDiv({ cls: "smart-import-modal__info" }),
        "建议标签",
        this.record.ai_tags_suggestion.join(" ")
      );
    }

    const field = contentEl.createDiv({ cls: "smart-import-modal__field" });
    const currentFolder = getDisplayFolder(this.record);
    this.selectedFolder = currentFolder;
    this.availableFolders = this.plugin.listVisibleFolders();

    field.createEl("label", { text: "选择目标文件夹" });
    this.folderSearchInput = field.createEl("input", {
      type: "text",
      placeholder: "搜索文件夹，例如：研究 / Projects / Inbox"
    });
    this.folderListEl = field.createDiv({ cls: "smart-import-folder-picker" });

    this.targetInput = field.createEl("input", {
      type: "text",
      value: currentFolder,
      placeholder: "或直接输入新路径，例如：1-Projects/新项目"
    });

    this.folderSearchInput.addEventListener("input", () => {
      this.renderFolderOptions();
    });

    this.targetInput.addEventListener("input", () => {
      this.selectedFolder = normalizePath(this.targetInput.value || "");
      this.renderFolderOptions();
    });

    this.renderFolderOptions();

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);
    const confirmButton = actions.createEl("button", { text: "确认移动" });
    const cancelButton = actions.createEl("button", { text: "取消" });
    confirmButton.classList.add("smart-import-primary-button");
    cancelButton.classList.add("smart-import-secondary-button");
    styleActionButton(confirmButton, "primary");
    styleActionButton(cancelButton, "secondary");

    confirmButton.addEventListener("click", async () => {
      const targetFolder = normalizePath((this.targetInput && this.targetInput.value) || "");
      if (!targetFolder) {
        new Notice("请选择或输入目标文件夹。", 5000);
        return;
      }

      confirmButton.disabled = true;
      try {
        const nextPath = await this.plugin.moveActivityCard(this.record, targetFolder);
        new Notice(`已移动到 ${nextPath}`, 6000);
        if (typeof this.onMoved === "function") {
          await this.onMoved();
        }
        this.close();
      } catch (error) {
        const message = error && error.message ? error.message : "移动失败。";
        new Notice(message, 7000);
      } finally {
        confirmButton.disabled = false;
      }
    });

    cancelButton.addEventListener("click", () => {
      this.close();
    });
  }
}

class RecentDownloadsConfirmModal extends Modal {
  constructor(app, items, options = {}) {
    super(app);
    this.items = Array.isArray(items) ? items : [];
    this.options = options || {};
    this.selectedPaths = new Set(this.items.map((item) => item.path).filter(Boolean));
    this.onDecision = null;
  }

  openAndGetSelection() {
    return new Promise((resolve) => {
      this.onDecision = resolve;
      this.open();
    });
  }

  finishWithSelection() {
    const selected = this.items.filter((item) => this.selectedPaths.has(item.path));
    if (typeof this.onDecision === "function") {
      this.onDecision(selected);
      this.onDecision = null;
    }
    this.close();
  }

  onClose() {
    if (this.onDecision) {
      this.onDecision([]);
      this.onDecision = null;
    }
    this.contentEl.empty();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    contentEl.createEl("h2", { text: "确认最近下载导入" });
    contentEl.createEl("p", {
      cls: "smart-import-description",
      text: this.options.usedFallback
        ? "最近时间范围内没有检测到新文件，以下是 Downloads 中最近识别到的可导入文件，请勾选后继续导入。"
        : "以下是最近新增的可导入文件，请勾选确认后继续导入。"
    });

    const list = contentEl.createDiv({ cls: "smart-import-recent-list" });
    this.items.forEach((item) => {
      const row = list.createDiv({ cls: "smart-import-recent-item" });
      const checkbox = row.createEl("input", {
        type: "checkbox"
      });
      checkbox.checked = this.selectedPaths.has(item.path);

      const body = row.createDiv({ cls: "smart-import-recent-item__body" });
      body.createEl("strong", { text: item.name || path.basename(item.path || "") });
      body.createEl("div", {
        cls: "smart-import-recent-item__meta",
        text: `来源：Downloads · ${formatImportedAtCompact(new Date(item.modifiedAt || Date.now()).toISOString())}`
      });
      body.createEl("div", {
        cls: "smart-import-recent-item__path",
        text: path.dirname(item.path || "")
      });

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectedPaths.add(item.path);
        } else {
          this.selectedPaths.delete(item.path);
        }
      });
    });

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);

    const cancelButton = actions.createEl("button", { text: "取消" });
    const confirmButton = actions.createEl("button", { text: "确认导入" });
    cancelButton.classList.add("smart-import-secondary-button");
    confirmButton.classList.add("smart-import-primary-button");
    styleActionButton(cancelButton, "secondary");
    styleActionButton(confirmButton, "primary");

    cancelButton.addEventListener("click", () => {
      if (typeof this.onDecision === "function") {
        this.onDecision([]);
        this.onDecision = null;
      }
      this.close();
    });

    confirmButton.addEventListener("click", () => {
      if (!this.selectedPaths.size) {
        new Notice("请至少勾选一个文件。", 5000);
        return;
      }
      this.finishWithSelection();
    });
  }
}

class DeleteImportConfirmModal extends Modal {
  constructor(app, plugin, record, onDecision) {
    super(app);
    this.plugin = plugin;
    this.record = record;
    this.onDecision = onDecision;
    this.skipFuturePrompt = false;
  }

  finish(decision) {
    if (typeof this.onDecision === "function") {
      this.onDecision(Boolean(decision));
      this.onDecision = null;
    }
    this.close();
  }

  onClose() {
    if (this.onDecision) {
      this.onDecision(false);
      this.onDecision = null;
    }
    this.contentEl.empty();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    contentEl.createEl("h2", { text: "确认删除" });
    const description = contentEl.createEl("p", {
      text: "删除后会从 Ob 中移除这条导入笔记及其内部记录，但不会删除电脑上的原始外部文件。"
    });
    description.addClass("smart-import-description");

    if (this.record) {
      addInfoRow(
        contentEl.createDiv({ cls: "smart-import-modal__info" }),
        "当前文件",
        getDisplayNameFromRecord(this.record)
      );
    }

    new Setting(contentEl)
      .setName("以后删除时不再提示")
      .setDesc("勾选后，后续点击“删除”将直接执行。可在插件设置中重新打开确认。")
      .addToggle((toggle) => {
        toggle.setValue(false).onChange((value) => {
          this.skipFuturePrompt = Boolean(value);
        });
      });

    const actions = contentEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);

    const cancelButton = actions.createEl("button", { text: "取消" });
    const confirmButton = actions.createEl("button", { text: "确认删除" });
    cancelButton.classList.add("smart-import-secondary-button");
    confirmButton.classList.add("smart-import-primary-button");
    styleActionButton(cancelButton, "secondary");
    styleActionButton(confirmButton, "primary");

    cancelButton.addEventListener("click", () => {
      this.finish(false);
    });

    confirmButton.addEventListener("click", async () => {
      if (this.skipFuturePrompt) {
        this.plugin.settings.confirmBeforeDelete = false;
        await this.plugin.saveSettings();
      }
      this.finish(true);
    });
  }
}

class DependencyInstallWizardModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.plan = null;
    this.statusEl = null;
    this.bodyEl = null;
  }

  async refreshPlan(force = true) {
    if (!this.statusEl || !this.bodyEl) {
      return;
    }

    this.statusEl.setText("正在检测本机依赖…");
    this.bodyEl.empty();
    try {
      this.plan = await this.plugin.buildDependencyInstallPlan(force);
      this.statusEl.setText("检测完成。");
      this.renderPlan();
    } catch (error) {
      this.statusEl.setText("检测失败。");
      this.bodyEl.createEl("div", {
        text: error && error.message ? error.message : "请稍后重试。"
      });
    }
  }

  renderPlan() {
    if (!this.bodyEl || !this.plan) {
      return;
    }

    const { missingItems, notes, platformLabel, environment } = this.plan;
    this.bodyEl.empty();

    const summary = this.bodyEl.createDiv({ cls: "smart-import-preview-card" });
    addInfoRow(summary.createDiv({ cls: "smart-import-modal__info" }), "平台", platformLabel);
    addInfoRow(
      summary.createDiv({ cls: "smart-import-modal__info" }),
      "markitdown 状态",
      environment.ok ? "已就绪" : "未就绪"
    );
    addInfoRow(
      summary.createDiv({ cls: "smart-import-modal__info" }),
      "缺失项",
      missingItems.length ? `${missingItems.length} 项` : "0 项"
    );

    if (missingItems.length) {
      const list = this.bodyEl.createEl("ul");
      missingItems.forEach((item) => {
        list.createEl("li", {
          text: `${item.required ? "必需" : "可选"}：${item.label}。${item.detail}`
        });
      });
    } else {
      this.bodyEl.createEl("p", {
        cls: "smart-import-description",
        text: "当前已检测到插件所需依赖。若导入仍异常，请检查“转换器路径”配置或 shell PATH。"
      });
    }

    if (notes && notes.length) {
      const noteCard = this.bodyEl.createDiv({ cls: "smart-import-preview-card" });
      noteCard.createEl("strong", { text: "提示" });
      const noteList = noteCard.createEl("ul");
      notes.forEach((note) => {
        noteList.createEl("li", { text: note });
      });
    }

    const commandCard = this.bodyEl.createDiv({ cls: "smart-import-preview-card" });
    commandCard.createEl("strong", { text: "安装命令" });
    commandCard.createEl("pre", {
      cls: "smart-import-preview-card__text",
      text: this.plan.commandText
    });

    const actions = this.bodyEl.createDiv({ cls: "smart-import-actions" });
    makeVisibleActionRow(actions);

    const refreshButton = actions.createEl("button", { text: "重新检测" });
    refreshButton.classList.add("smart-import-secondary-button");
    styleActionButton(refreshButton, "secondary");
    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      try {
        await this.refreshPlan(true);
      } finally {
        refreshButton.disabled = false;
      }
    });

    const copyButton = actions.createEl("button", { text: "复制命令" });
    copyButton.classList.add("smart-import-secondary-button");
    styleActionButton(copyButton, "secondary");
    copyButton.addEventListener("click", async () => {
      const copied = await this.plugin.copyTextToClipboard(this.plan.commandText);
      new Notice(copied ? "安装命令已复制到剪贴板。" : "当前环境无法写入剪贴板，请手动复制。", 5000);
    });

    if (this.plan.canResetConverterPath) {
      const resetButton = actions.createEl("button", { text: "清空转换器路径" });
      resetButton.classList.add("smart-import-secondary-button");
      styleActionButton(resetButton, "secondary");
      resetButton.addEventListener("click", async () => {
        this.plugin.settings.converterPath = "";
        await this.plugin.saveSettings();
        new Notice("已清空“转换器路径”，请重新检测环境。", 5000);
        await this.refreshPlan(true);
      });
    }

    if (this.plan.hasAutoInstall) {
      const runButton = actions.createEl("button", { text: "在终端中运行安装命令" });
      runButton.classList.add("smart-import-primary-button");
      styleActionButton(runButton, "primary");
      runButton.addEventListener("click", async () => {
        runButton.disabled = true;
        try {
          await this.plugin.runDependencyInstallPlan(this.plan);
          new Notice("已打开系统终端并开始执行安装命令。过程中可能需要输入系统密码。", 7000);
        } catch (error) {
          new Notice(error && error.message ? error.message : "打开终端失败。", 7000);
        } finally {
          runButton.disabled = false;
        }
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("smart-import-modal");

    contentEl.createEl("h2", { text: "依赖安装向导" });
    contentEl.createEl("p", {
      cls: "smart-import-description",
      text: "向导会检测当前机器缺失的本地依赖，并在支持的平台上打开系统终端执行安装命令。执行前请先确认你信任这些系统级安装动作。"
    });

    this.statusEl = contentEl.createEl("p", {
      cls: "smart-import-description smart-import-description--subtle",
      text: "正在检测本机依赖…"
    });
    this.bodyEl = contentEl.createDiv();
    this.refreshPlan(true);
  }
}

class SmartImportSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.environmentStatusEl = null;
    this.environmentStatusMetaEl = null;
  }

  renderEnvironmentStatus(environment) {
    if (!this.environmentStatusEl) {
      return;
    }

    this.environmentStatusEl.empty();
    const summary = environment.ok
      ? `markitdown 已就绪${environment.version ? `：${environment.version}` : "。"}`
      : `markitdown 未就绪：${environment.detail || "请检查路径或系统 PATH。"}`;

    this.environmentStatusEl.createEl("div", { text: summary });
    this.environmentStatusEl.createEl("div", {
      cls: "setting-item-description",
      text: environment.ok
        ? (
          environment.optionalDependencies && environment.optionalDependencies.length
            ? `可选依赖缺失：${environment.optionalDependencies.join("、")}`
            : "可选依赖已就绪。"
        )
        : "缺少必需依赖时，docx / pdf / pptx / xlsx / xls / doc 等需要转换的文件将无法导入。"
    });
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "文件管理" });

    const dependencySection = containerEl.createDiv();
    dependencySection.createEl("h3", { text: "本地依赖与兼容性" });
    dependencySection.createEl("p", {
      cls: "setting-item-description",
      text: "通过 GitHub 或 BRAT 安装后，插件会直接在本机调用这些工具。缺少必需依赖时，相关导入能力会受限。"
    });
    const dependencyList = dependencySection.createEl("ul");
    LOCAL_DEPENDENCY_REQUIREMENTS.required.forEach((item) => {
      dependencyList.createEl("li", { text: `必需：${item}` });
    });
    LOCAL_DEPENDENCY_REQUIREMENTS.optional.forEach((item) => {
      dependencyList.createEl("li", { text: `可选：${item}` });
    });
    LOCAL_DEPENDENCY_REQUIREMENTS.notes.forEach((item) => {
      dependencyList.createEl("li", { text: `说明：${item}` });
    });

    const environmentCard = dependencySection.createDiv({ cls: "smart-import-preview-card" });
    environmentCard.createEl("strong", { text: "当前环境检测" });
    this.environmentStatusMetaEl = environmentCard.createEl("div", {
      cls: "setting-item-description",
      text: "正在检测本机依赖…"
    });
    this.environmentStatusEl = environmentCard.createDiv();
    this.plugin.checkEnvironment(true).then((environment) => {
      if (this.environmentStatusMetaEl) {
        this.environmentStatusMetaEl.setText("状态会随“重新检测环境”实时刷新。");
      }
      this.renderEnvironmentStatus(environment);
    }).catch((error) => {
      if (this.environmentStatusMetaEl) {
        this.environmentStatusMetaEl.setText("环境检测失败。");
      }
      this.renderEnvironmentStatus({
        ok: false,
        detail: error && error.message ? error.message : "请检查本地依赖和 PATH。",
        version: "",
        optionalDependencies: []
      });
    });

    new Setting(containerEl)
      .setName("重新检测环境")
      .setDesc("刷新 markitdown 与可选本地依赖的检测结果。")
      .addButton((button) =>
        button.setButtonText("立即检测").onClick(async () => {
          button.setDisabled(true);
          if (this.environmentStatusMetaEl) {
            this.environmentStatusMetaEl.setText("正在检测本机依赖…");
          }
          try {
            const environment = await this.plugin.checkEnvironment(true);
            this.renderEnvironmentStatus(environment);
            if (this.environmentStatusMetaEl) {
              this.environmentStatusMetaEl.setText("已刷新。");
            }
          } finally {
            button.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName("依赖安装向导")
      .setDesc("检测缺失依赖，并在支持的平台上打开系统终端执行安装命令。")
      .addButton((button) =>
        button.setButtonText("打开向导").onClick(async () => {
          await this.plugin.openDependencyInstallWizard();
        })
      );

    new Setting(containerEl)
      .setName("转换器路径")
      .setDesc("markitdown 的绝对路径。留空则尝试使用系统 PATH；EPUB 可回退到 pandoc，MOBI/AZW3 可回退到 Calibre 的 ebook-convert。")
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/markitdown 或留空自动探测")
          .setValue(this.plugin.settings.converterPath)
          .onChange(async (value) => {
            this.plugin.settings.converterPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Inbox 目录")
      .setDesc("导入后的 Markdown 默认保存到这个 Vault 相对目录。")
      .addText((text) =>
        text
          .setPlaceholder("Inbox")
          .setValue(this.plugin.settings.outputDir)
          .onChange(async (value) => {
            this.plugin.settings.outputDir = normalizePath(value.trim() || DEFAULT_SETTINGS.outputDir);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("启用建议")
      .setDesc("导入后生成摘要、标签和保存位置建议。当前为本地规则版，后续可替换为 AI provider。")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(this.plugin.settings.enableAiSuggestions)).onChange(async (value) => {
          this.plugin.settings.enableAiSuggestions = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("AI Provider")
      .setDesc("选择建议生成方式。`本地规则` 不依赖外部 AI，`OpenAI Compatible` 通过兼容接口请求模型。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("rules", "本地规则")
          .addOption("openai-compatible", "OpenAI Compatible")
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value) => {
            this.plugin.settings.aiProvider = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.aiProvider === "openai-compatible") {
      new Setting(containerEl)
        .setName("AI Base URL")
        .setDesc("OpenAI Compatible 接口地址，默认 `https://api.openai.com/v1`。")
        .addText((text) =>
          text
            .setPlaceholder("https://api.openai.com/v1")
            .setValue(this.plugin.settings.aiProviderBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.aiProviderBaseUrl = value.trim() || "https://api.openai.com/v1";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("AI Model")
        .setDesc("例如 `gpt-4.1-mini` 或兼容服务的模型名。")
        .addText((text) =>
          text
            .setPlaceholder("gpt-4.1-mini")
            .setValue(this.plugin.settings.aiProviderModel)
            .onChange(async (value) => {
              this.plugin.settings.aiProviderModel = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("AI API Key")
        .setDesc("仅在本地保存，用于调用兼容接口。")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.aiProviderApiKey)
            .onChange(async (value) => {
              this.plugin.settings.aiProviderApiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("导入笔记宽度")
      .setDesc("控制导入笔记在中间阅读/编辑区域的版心宽度。也可以在导入笔记顶部点击“宽度”按钮随时切换。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("standard", "标准")
          .addOption("wide", "宽版")
          .addOption("full", "全宽")
          .setValue(normalizeImportedNoteWidthMode(this.plugin.settings.importedNoteWidthMode))
          .onChange(async (value) => {
            this.plugin.settings.importedNoteWidthMode = normalizeImportedNoteWidthMode(value);
            await this.plugin.saveSettings();
            await this.plugin.refreshImportedNoteChrome();
          })
      );

    new Setting(containerEl)
      .setName("最近下载时间范围")
      .setDesc("点击“最近下载”时，会扫描这个时间范围内的 Downloads 文件。单位：分钟。")
      .addText((text) =>
        text
          .setPlaceholder("120")
          .setValue(String(this.plugin.settings.recentDownloadsLookbackMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.recentDownloadsLookbackMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("保留原件")
      .setDesc("将原始文件保留到 .openclaw/source-files/ 中。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.keepOriginal).onChange(async (value) => {
          this.plugin.settings.keepOriginal = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("删除前确认")
      .setDesc("删除导入记录前是否弹出确认窗口。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.confirmBeforeDelete).onChange(async (value) => {
          this.plugin.settings.confirmBeforeDelete = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("重建活动流")
      .setDesc("清空并重扫业务文件，用于 watcher 漏记、规则调整后恢复或升级回填。")
      .addButton((button) =>
        button.setButtonText("立即重建").onClick(async () => {
          button.setDisabled(true);
          try {
            new Notice("正在重建活动流…", 4000);
            await this.plugin.rebuildActivityStore();
            new Notice("活动流已重建。", 5000);
          } finally {
            button.setDisabled(false);
          }
        })
      );
  }
}

function addInfoRow(container, label, value) {
  const row = container.createDiv({ cls: "smart-import-info-row" });
  row.createEl("span", { cls: "smart-import-info-row__label", text: `${label}:` });
  row.createEl("span", { cls: "smart-import-info-row__value", text: value || "不可用" });
}

function replaceFrontmatterField(content, key, nextValue) {
  const pattern = new RegExp(`(^${escapeRegExp(key)}:\\s*)(.*)$`, "m");
  return content.replace(pattern, `$1${yamlString(nextValue)}`);
}
