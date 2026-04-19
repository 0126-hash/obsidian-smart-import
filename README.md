# Smart Import

Desktop-only Obsidian plugin for importing external files into your vault and converting them into Markdown.

## Current repository status

This repo was reconstructed from the deployed plugin bundle in a local vault. The original TypeScript source was not available, so the maintained source of truth here is:

- `src/main.js`
- `src/ocr_pdf.py`

The build step copies these sources into release-ready root files.

## What the plugin does

- imports files and folders from outside the vault
- supports file picker, drag-and-drop, recent downloads, Finder selection, clipboard, and natural-language lookup flows
- converts supported documents into Markdown notes with import frontmatter
- preserves original source files inside the vault when enabled
- generates partial stub notes for low-quality PDFs and unsupported files instead of failing silently
- can extract embedded media assets from Office files when available
- optionally applies OpenAI-compatible cleanup and suggestion flows, with local rule-based fallback

## Main commands

- `Smart Import: 导入文件`
- `Smart Import: 导入文件夹`
- `Smart Import: 导入最近下载`
- `Smart Import: 导入 Finder 当前选中`
- `Smart Import: 自然语言导入`

## Platform support

- Supported: desktop Obsidian
- Best-tested: macOS
- Not guaranteed: Windows and Linux

The current codebase contains macOS-specific helpers such as `mdfind` and `osascript`.

## External dependencies

Required for general conversion:

- `markitdown`

Optional but recommended:

- `python3`
- `tesseract`
- `pypdfium2` Python package
- `LibreOffice` or `soffice`

Examples:

```bash
pipx install markitdown
python3 -m pip install pypdfium2
brew install tesseract libreoffice
```

## Local development

```bash
npm install
npm run build
```

That command:

- validates `src/main.js`
- validates `src/ocr_pdf.py`
- copies build outputs to `main.js` and `ocr_pdf.py`

To produce GitHub release assets:

```bash
npm run release:prepare
```

See [RELEASING.md](./RELEASING.md) for the full release flow.

## Install from GitHub

### Option 1: BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Open BRAT and run `Add a beta plugin for testing`
3. In the repository field, enter this repo slug:

```text
0126-hash/obsidian-smart-import
```

4. Choose `Latest version`
5. Keep `Enable after installing the plugin` checked
6. Click `Add plugin`
7. Confirm that `Smart Import` is enabled in Community Plugins

### Option 2: GitHub Release assets

Download the latest release and copy these files into:

```text
<your-vault>/.obsidian/plugins/smart-import/
```

- `main.js`
- `manifest.json`
- `styles.css`

Then enable `Smart Import` in Community Plugins.

### First launch

First launch is non-blocking:

- `md` and `txt` imports work immediately
- if you later import `docx`, `pdf`, `pptx`, `xlsx`, `xls`, or `doc` without `markitdown`, Smart Import will open the dependency install wizard for you
- on macOS, the wizard can open Terminal and run the recommended install commands after you confirm

## Manual install into Obsidian

Copy these files into:

```text
<your-vault>/.obsidian/plugins/smart-import/
```

- `main.js`
- `manifest.json`
- `styles.css`
- `ocr_pdf.py`

## Operational notes

- The plugin copies original source files into the vault.
- The plugin may read clipboard contents and, on macOS, inspect clipboard file paths and Finder selection.
- Natural-language import searches local folders such as `~/Downloads` and `~/Desktop`, and may also look at Finder selection or clipboard file candidates when the request implies them.
- When AI features are enabled and an OpenAI-compatible provider is configured, note content and import snapshots may be sent to that provider.
- Environment diagnostics now distinguish between required and optional dependencies so users can tell whether only advanced OCR or `.doc` import is affected.
- The settings page now includes a dependency install wizard that can open Terminal on macOS and run the recommended install commands after user confirmation.
- For community-plugin installs, the OCR helper script is generated on demand by `main.js`, so the standard Obsidian release assets remain sufficient.

See [PRIVACY.md](./PRIVACY.md) for data handling notes.
