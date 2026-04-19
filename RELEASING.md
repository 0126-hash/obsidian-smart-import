# Releasing

## 1. Bump version

```bash
npm run version:bump -- 0.1.1
```

You can also use `patch`, `minor`, or `major`.

## 2. Build and package release assets

```bash
npm install
npm run release:prepare
```

This creates:

- `dist/main.js`
- `dist/manifest.json`
- `dist/styles.css`
- `dist/<plugin-id>-<version>.zip`

The zip also contains `ocr_pdf.py` for manual installation. Community-plugin installation still works from the standard three release assets because the plugin now self-generates the OCR helper when needed.

## 3. Commit and tag

```bash
git add .
git commit -m "release: 0.1.1"
git tag 0.1.1
git push origin main --tags
```

The GitHub release workflow publishes assets automatically when the tag is pushed.

## 4. First-time GitHub setup

```bash
git remote add origin <your-github-repo-url>
git branch -M main
git push -u origin main
```

## 5. Submit to Obsidian Community Plugins

Before submission, re-check:

- README clearly states desktop-only support and external dependencies
- release assets include `main.js`, `manifest.json`, and `styles.css`
- root contains `README.md`, `LICENSE`, `manifest.json`, and `versions.json`
