#!/usr/bin/env node

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "../../..");
const pluginPath = path.join(repoRoot, "staging/obsidian/plugins/smart-import/main.js");
const fixturesDir = path.join(repoRoot, "output/smart-import-0.2.6-acceptance/fixtures");
const vaultRoot = path.join(repoRoot, "output/smart-import-0.2.6-acceptance/mock-vault");
const reportPath = path.join(repoRoot, "output/smart-import-0.2.6-acceptance/plugin-e2e-report.json");
const sentinel = "SMART_IMPORT_026_SENTINEL";

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

class MockTFile {
  constructor(filePath) {
    this.path = normalizePath(filePath);
    this.name = path.posix.basename(this.path);
    this.extension = path.posix.extname(this.path).slice(1);
  }
}

class MockTFolder {
  constructor(folderPath) {
    this.path = normalizePath(folderPath);
    this.name = path.posix.basename(this.path);
  }
}

class MockAdapter {
  constructor(basePath) {
    this.basePath = basePath;
  }

  getBasePath() {
    return this.basePath;
  }

  absolute(vaultPath) {
    return path.join(this.basePath, normalizePath(vaultPath));
  }

  async exists(vaultPath) {
    return fs.access(this.absolute(vaultPath)).then(() => true).catch(() => false);
  }

  async read(vaultPath) {
    return fs.readFile(this.absolute(vaultPath), "utf8");
  }

  async write(vaultPath, content) {
    const absolutePath = this.absolute(vaultPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }

  async remove(vaultPath) {
    await fs.rm(this.absolute(vaultPath), { force: true });
  }

  async rmdir(vaultPath, recursive = false) {
    await fs.rm(this.absolute(vaultPath), { recursive, force: true });
  }
}

class MockVault {
  constructor(basePath) {
    this.adapter = new MockAdapter(basePath);
  }

  async createFolder(vaultPath) {
    await fs.mkdir(this.adapter.absolute(vaultPath), { recursive: true });
    return new MockTFolder(vaultPath);
  }

  async create(vaultPath, content) {
    const normalized = normalizePath(vaultPath);
    const absolutePath = this.adapter.absolute(normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return new MockTFile(normalized);
  }

  async modify(file, content) {
    await this.adapter.write(file.path, content);
  }

  async cachedRead(file) {
    return this.adapter.read(file.path);
  }

  getAbstractFileByPath(vaultPath) {
    const normalized = normalizePath(vaultPath);
    const absolutePath = this.adapter.absolute(normalized);
    if (!fsSync.existsSync(absolutePath)) {
      return null;
    }
    const stat = fsSync.statSync(absolutePath);
    return stat.isDirectory() ? new MockTFolder(normalized) : new MockTFile(normalized);
  }

  on() {
    return { unload: () => {} };
  }
}

function installObsidianMock() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      class Plugin {
        constructor() {
          this.app = null;
        }
        async loadData() { return {}; }
        async saveData() {}
        addRibbonIcon() { return { addClass: () => {} }; }
        addCommand() {}
        addSettingTab() {}
        registerView() {}
        registerDomEvent() {}
        registerEvent() {}
      }
      class Notice {
        constructor(message) {
          this.message = message;
          this.noticeEl = { setText: () => {} };
        }
        hide() {}
      }
      return {
        ItemView: class {},
        Modal: class {},
        Notice,
        Plugin,
        PluginSettingTab: class {},
        requestUrl: async () => ({ text: "" }),
        Setting: class {},
        TFile: MockTFile,
        TFolder: MockTFolder,
        normalizePath,
      };
    }
    return originalLoad.apply(this, arguments);
  };
}

function createMockApp() {
  const vault = new MockVault(vaultRoot);
  return {
    vault,
    workspace: {
      onLayoutReady(callback) { callback(); },
      on() { return { unload: () => {} }; },
      getActiveFile() { return null; },
      detachLeavesOfType() {},
      getLeavesOfType() { return []; },
      getRightLeaf() { return { setViewState: async () => {}, openFile: async () => {} }; },
      getLeaf() { return { openFile: async () => {} }; },
      revealLeaf: async () => {},
      activeLeaf: null,
    },
    metadataCache: {
      getFileCache() { return {}; },
    },
  };
}

function normalizeSentinelContent(content) {
  return String(content || "").replace(/\\_/g, "_");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  await fs.rm(vaultRoot, { recursive: true, force: true });
  await fs.mkdir(vaultRoot, { recursive: true });
  installObsidianMock();

  const SmartImportPlugin = require(pluginPath);
  const plugin = new SmartImportPlugin();
  plugin.app = createMockApp();
  plugin.settings = {
    converterPath: "",
    outputDir: "Inbox",
    keepOriginal: true,
    enableMarkitdownPlugins: false,
    enableAiSuggestions: false,
    recentDownloadsLookbackMinutes: 120,
    confirmBeforeDelete: true,
    importedNoteWidthMode: "wide",
    activitySortMode: "recent_entered",
    aiProvider: "rules",
    aiProviderBaseUrl: "https://api.openai.com/v1",
    aiProviderModel: "",
    aiProviderApiKey: "",
    dependencyWizardLastPromptedVersion: "",
  };
  plugin.saveSettings = async () => {};
  plugin.refreshInboxViews = async () => {};
  plugin.refreshImportedNoteChrome = async () => {};

  const fixtureNames = (await fs.readdir(fixturesDir))
    .filter((name) => /\.(azw3|csv|docx|eml|epub|html|ipynb|json|md|mobi|pdf|pptx|txt|xlsx|xml|zip)$/i.test(name))
    .sort();

  const results = [];
  for (const fixtureName of fixtureNames) {
    const fixturePath = path.join(fixturesDir, fixtureName);
    const result = await plugin.importExternalFile(fixturePath, "acceptance-e2e", {
      outputDir: "Inbox",
      keepOriginal: true,
      skipAiHydration: true,
    });
    const notePath = result && result.notePath ? result.notePath : "";
    const noteAbsolutePath = notePath ? path.join(vaultRoot, normalizePath(notePath)) : "";
    const recordPath = notePath
      ? path.join(vaultRoot, ".openclaw/import-records", `${path.basename(result.originalFile || "", path.extname(result.originalFile || ""))}.json`)
      : "";
    const noteContent = noteAbsolutePath ? await fs.readFile(noteAbsolutePath, "utf8").catch(() => "") : "";
    const normalizedNote = normalizeSentinelContent(noteContent);
    const originalExists = result && result.originalFile
      ? fsSync.existsSync(path.join(vaultRoot, normalizePath(result.originalFile)))
      : false;
    const importRecord = await readJsonIfExists(recordPath);
    results.push({
      file: fixtureName,
      status: result && result.status,
      notePath,
      noteExists: Boolean(noteAbsolutePath && fsSync.existsSync(noteAbsolutePath)),
      sentinelFound: normalizedNote.includes(sentinel),
      originalFile: result && result.originalFile,
      originalExists,
      importRecordPath: importRecord && importRecord.import_record_path || "",
      importRecordExists: Boolean(importRecord),
      converter: importRecord && importRecord.converter_name || "",
    });
  }

  const activityStorePath = path.join(vaultRoot, ".openclaw/file-activities/activity-store.json");
  const activityStore = await readJsonIfExists(activityStorePath);
  const summary = {
    pluginVersion: "0.2.6",
    vaultRoot,
    total: results.length,
    passed: results.filter((item) => item.noteExists && item.sentinelFound && item.originalExists && item.importRecordExists).length,
    failed: results.filter((item) => !(item.noteExists && item.sentinelFound && item.originalExists && item.importRecordExists)),
    activityCards: activityStore && Array.isArray(activityStore.cards) ? activityStore.cards.length : 0,
    results,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed.length,
    activityCards: summary.activityCards,
    report: reportPath,
  }, null, 2));
  return summary.failed.length ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
