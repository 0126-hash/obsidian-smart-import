# Contributing

## Local setup

```bash
npm install
npm run build
```

## Development rules

- keep `package.json`, `manifest.json`, and `versions.json` aligned
- keep `src/main.js` as the editable source of truth
- keep the plugin desktop-only unless native shell and Electron dependencies are removed
- document any new system dependency in `README.md`

## Before opening a PR

```bash
npm run build
```

The build validates both the JavaScript entrypoint and the OCR helper source.
