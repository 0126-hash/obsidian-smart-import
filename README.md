# Smart Import

Desktop-only Obsidian plugin for importing external files into your vault and converting them into Markdown.

## Current repository status

This repo was reconstructed from the deployed plugin bundle in a local vault. The original TypeScript source was not available, so the maintained source of truth here is:

- `src/main.js`
- `src/ocr_pdf.py`

The build step copies these sources into release-ready root files.

## What the plugin does

- imports files from outside the vault
- converts supported files into Markdown
- stores imported source files inside the vault
- supports clipboard and file-picker driven import flows
- optionally applies AI-based cleanup and suggestions

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

## Install into Obsidian

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
- The plugin may read clipboard contents and, on macOS, inspect clipboard file paths.
- When AI features are enabled, note content and import snapshots may be sent to the configured AI provider.
- Environment diagnostics now distinguish between required and optional dependencies so users can tell whether only advanced OCR or `.doc` import is affected.
- For community-plugin installs, the OCR helper script is generated on demand by `main.js`, so the standard Obsidian release assets remain sufficient.

See [PRIVACY.md](./PRIVACY.md) for data handling notes.
