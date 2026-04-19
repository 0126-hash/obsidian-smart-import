# Community Plugin Submission Prep

This file collects the exact metadata needed to submit `Smart Import` to the Obsidian Community Plugins directory.

## Repository

- repo: `0126-hash/obsidian-smart-import`
- branch: `main`
- manifest path: `/manifest.json`

## Community directory entry

```json
{
  "id": "smart-import",
  "name": "Smart Import",
  "author": "xuziming",
  "description": "Desktop-only file importer for Obsidian that converts external files into Markdown and stores source assets inside the vault.",
  "repo": "0126-hash/obsidian-smart-import"
}
```

## Release asset checklist

Every GitHub release submitted to Obsidian must include:

- `main.js`
- `manifest.json`
- `styles.css`

This repo also publishes a zip for manual installation, but Community Plugins only requires the three standard assets.

## Review notes for maintainers

- desktop-only plugin
- best-tested on macOS
- external dependency required for general conversion: `markitdown`
- optional dependencies for OCR and legacy office formats: `python3`, `tesseract`, `pypdfium2`, `LibreOffice`
- OCR helper is generated on demand by the plugin, so Community Plugin installation does not need a separate script asset

## Pre-submit checklist

- `README.md`, `LICENSE`, `manifest.json`, `versions.json` exist at repo root
- latest GitHub release contains the three standard assets
- `manifest.json` version matches the Git tag
- README clearly explains external dependencies and platform limitations
