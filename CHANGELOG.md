# Changelog

## 0.2.1

- removed `Obsidian` from the plugin description so Community Plugin validation accepts the submission metadata
- refreshed community submission metadata for the 0.2.1 patch release

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
