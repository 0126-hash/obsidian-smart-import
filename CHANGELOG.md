# Changelog

## 0.2.5

- added EPUB, MOBI, and AZW3 to file picker, drag-and-drop, clipboard, recent downloads, and activity stream handling
- added ebook conversion fallbacks: EPUB can use pandoc, while MOBI/AZW3 can use Calibre's `ebook-convert`
- updated dependency diagnostics and user-facing notices for ebook import failures

## 0.2.4

- fixed a false-positive legacy-layout migration that could rewrite fresh imports after opening them
- fixed duplicated `Original File` sections by making section replacement collapse duplicate headings into a single canonical block
- added automatic cleanup for already-imported notes that were previously saved with duplicate `Original File` or `Warnings` sections

## 0.2.3

- made `markitdown` detection more robust for GUI installs by probing common user-local bin directories before falling back to shell lookup
- stopped auto-opening the dependency wizard on first launch so `md` and `txt` imports are not blocked for brand-new installs
- updated BRAT install instructions to use the repo slug plus `Latest version`, matching the flow that works reliably in testing

## 0.2.2

- added first-launch dependency prompting so GitHub / BRAT installs can reach a working state faster
- rewrote install docs around GitHub Release and BRAT flows instead of assuming community-directory discovery
- expanded the dependency install wizard so users can open it from settings or the command palette and run the recommended local install commands in Terminal on macOS

## 0.2.1

- removed `Obsidian` from the plugin description so Community Plugin validation accepts the submission metadata
- refreshed community submission metadata for the 0.2.1 patch release
- added a semi-automatic dependency install wizard that can open Terminal on macOS and run the recommended local install commands

## 0.2.0

- added import frontmatter and explicit stub-note handling for partial or unsupported imports
- added review-before-import flows for file picker, drag-and-drop, recent downloads, Finder selection, and natural-language lookup
- added formal `Import Folder`, `Import Finder 当前选中`, and `自然语言导入` commands
- aligned all remote AI behavior behind the explicit AI enablement gate
- improved Office media extraction and result summaries for batch imports
- reduced expensive AI hydration during inbox browsing
- added community submission prep metadata for the Obsidian directory

## 0.1.0

- reconstructed a maintainable source repository from the deployed plugin bundle
- added build, validation, version bump, and release packaging scripts
- added CI and automated GitHub release workflows
- improved environment diagnostics for required and optional dependencies
- made the PDF OCR helper self-generating so community-plugin installs do not depend on extra release assets
- made record deletion safer by removing files before deleting the record file
- added standardized import frontmatter and explicit success / partial / failure note templates
- added review-before-import flows for file picker, drag-and-drop, recent downloads, Finder selection, and natural-language import
- added batch import result summaries and unsupported-file placeholder notes
- added Office media extraction and safer partial handling for low-quality PDFs
- aligned remote AI behavior behind the explicit AI enablement setting
- added release, privacy, and contribution documentation
