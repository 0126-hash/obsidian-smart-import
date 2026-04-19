# Privacy

Smart Import processes local files and may also send content to an AI provider when AI features are enabled.

## Local data access

- reads files outside the vault that you explicitly choose to import
- may inspect clipboard content and clipboard file paths
- may inspect Finder current selection on macOS when you invoke that import mode
- may search local folders such as `~/Downloads` and `~/Desktop` when you use natural-language import
- stores imported source files inside the vault
- writes internal import records under `.openclaw/`

## External network use

When AI features are enabled and an OpenAI-compatible provider is configured, the plugin may send:

- import record snapshots
- extracted text
- OCR output

to the configured AI provider endpoint.

## External dependencies

The plugin may execute locally installed tools such as:

- `markitdown`
- `python3`
- `tesseract`
- `LibreOffice`

These tools run on your machine and are not bundled by this repository.
