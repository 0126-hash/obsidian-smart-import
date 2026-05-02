# Smart Import 0.2.6 验收记录

生成时间：2026-05-02

## 范围

本验收包用于验证 Smart Import 0.2.6 新增格式能力的底层转换链路，并给 Obsidian UI 端到端复验提供标准文件集。

测试哨兵文本：

```text
SMART_IMPORT_026_SENTINEL
```

只要导入后的 Markdown 能看到该文本，就说明内容没有在转换中丢失。

## 文件位置

- 测试文件：`output/smart-import-0.2.6-acceptance/fixtures/`
- 转换结果：`output/smart-import-0.2.6-acceptance/converted/`
- 机器可读结果：`output/smart-import-0.2.6-acceptance/test-manifest.json`
- 生成脚本：`output/smart-import-0.2.6-acceptance/scripts/generate_and_smoke.py`

## 本机依赖状态

| 依赖 | 状态 |
| --- | --- |
| markitdown | `/Users/xuziming/.local/bin/markitdown` |
| pandoc | `/opt/homebrew/bin/pandoc` |
| ebook-convert | `/opt/homebrew/bin/ebook-convert`，Calibre 9.8.0 |

## 自动转换验收结果

| 格式 | 测试文件 | 转换器 | 结果 |
| --- | --- | --- | --- |
| azw3 | `smart-import-026-azw3.azw3` | ebook-convert | 通过 |
| csv | `smart-import-026-csv.csv` | markitdown | 通过 |
| docx | `smart-import-026-docx.docx` | markitdown | 通过 |
| eml | `smart-import-026-eml.eml` | markitdown | 通过 |
| epub | `smart-import-026-epub.epub` | pandoc | 通过 |
| html | `smart-import-026-html.html` | markitdown | 通过 |
| ipynb | `smart-import-026-ipynb.ipynb` | markitdown | 通过 |
| json | `smart-import-026-json.json` | markitdown | 通过 |
| md | `smart-import-026-md.md` | direct-copy | 通过 |
| mobi | `smart-import-026-mobi.mobi` | ebook-convert | 通过 |
| pdf | `smart-import-026-pdf.pdf` | markitdown | 通过 |
| pptx | `smart-import-026-pptx.pptx` | markitdown | 通过 |
| txt | `smart-import-026-txt.txt` | direct-copy | 通过 |
| xlsx | `smart-import-026-xlsx.xlsx` | markitdown | 通过 |
| xml | `smart-import-026-xml.xml` | markitdown | 通过 |
| zip | `smart-import-026-zip.zip` | markitdown | 通过 |

自动转换汇总：16 通过，0 失败。

## Smart Import 端到端自动验收结果

已使用 `scripts/run_plugin_import_e2e.js` 创建独立 mock vault，并直接调用 Smart Import 0.2.6 的 `importExternalFile` 导入 `fixtures/` 中的 16 个测试文件。

验收输出：

- Mock Vault：`output/smart-import-0.2.6-acceptance/mock-vault/`
- E2E 机器结果：`output/smart-import-0.2.6-acceptance/plugin-e2e-report.json`

检查项：

| 检查项 | 结果 |
| --- | --- |
| 生成 `Inbox/*.md` | 16/16 通过 |
| Markdown 包含 `SMART_IMPORT_026_SENTINEL` | 16/16 通过 |
| 原件进入 `.openclaw/source-files/` | 16/16 通过 |
| 导入记录进入 `.openclaw/import-records/` | 16/16 通过 |
| 活动流记录进入 `.openclaw/file-activities/activity-store.json` | 16/16 通过 |

端到端汇总：16 通过，0 失败。

说明：PDF 样本在端到端结果中为 `partial_success`，原因是插件会对 PDF 走 OCR 增强判断；该样本的正文哨兵文本、原件保存、导入记录和活动流均已通过。

## 尚未自动通过的格式

| 格式 | 状态 | 原因 | 下一步 |
| --- | --- | --- | --- |
| msg | 手工验收 | 无法用纯文本生成真实 Outlook MSG 二进制样本 | 准备真实 `.msg` 文件后通过 UI 导入复验 |

## Obsidian UI 端到端复验清单

在 Obsidian 中打开 Smart Import 0.2.6 后，使用 `fixtures/` 目录里的测试文件逐个导入。

每个文件检查：

- 文件选择器或拖拽入口能识别该文件。
- 导入后在 `Inbox/` 下生成 Markdown 笔记。
- 笔记正文包含 `SMART_IMPORT_026_SENTINEL`。
- 如果开启“保留原件”，原始文件进入 `.openclaw/source-files/`。
- 导入记录进入 `.openclaw/import-records/`。
- 活动流出现对应导入记录。
- 失败时错误提示能说明依赖或文件格式问题。

## 复跑命令

```bash
/Users/xuziming/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 output/smart-import-0.2.6-acceptance/scripts/generate_and_smoke.py
```

端到端导入复跑：

```bash
node output/smart-import-0.2.6-acceptance/scripts/run_plugin_import_e2e.js
```

复跑后查看：

```bash
jq -r '.results[] | [.format,.status,.file,.converter,.sentinel_found] | @tsv' output/smart-import-0.2.6-acceptance/test-manifest.json
jq -r '.results[] | [.file,.status,.noteExists,.sentinelFound,.originalExists,.importRecordExists,.converter] | @tsv' output/smart-import-0.2.6-acceptance/plugin-e2e-report.json
```
