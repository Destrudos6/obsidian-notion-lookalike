# Notion Look-alike Importer (Obsidian plugin)

[中文](README.md) | **English**

A **read-only, complete** backup of a Notion workspace into Obsidian that keeps Notion's look as far as possible — plus a "Notion mode" that makes Obsidian feel like Notion for single-person use.

The first design rule is **never lose data**: the plugin never writes to Notion; local edits are always backed up before anything overwrites them; pages deleted in Notion are moved aside, never deleted.

> Current version: v1.0.0. A personal project. Desktop tested on Linux and Windows 11; mobile only tested with simulated touch, not on a real device. The plugin UI is mostly in Chinese, with English command names.

---

## Contents
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Setting up the Notion integration](#setting-up-the-notion-integration)
- [Usage](#usage)
- [Folder layout](#folder-layout)
- [Settings reference](#settings-reference)
- [Shortcuts](#shortcuts-in-notion-mode)
- [Privacy & security](#privacy--security)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Features

### Importer / backup (one-way, read-only)
- **Pages and databases**: pages → Markdown notes; databases → Obsidian **Bases** (`.base` files), one note per row, properties in frontmatter.
- **All views**: table, board, gallery, list, calendar, chart and form views are converted in Notion's view order; linked views keep only their own views. Timeline views become tables.
- **Properties**: title, text, number, select / multi-select / status (with Notion colours), dates (time, time zone, ranges), people, files, checkbox, URL, e-mail, phone, relations (completed past the 25-item API limit), unique ID and more; unknown types are kept as JSON.
- **Formulas and rollups**: translated into **live Bases formulas** where possible; otherwise the value Notion computed is written and the report says why.
- **Attachments**: Notion-hosted images, files, covers and icons are downloaded into the vault (optionally external files too).
- **Raw layer `_raw/`**: the raw JSON of every page, block and database the API returned — the most complete backup; notes can be rebuilt from it offline at any time.
- **Notion's own Markdown** (optional): a second raw copy of every page via Notion's Markdown endpoint.
- **Database templates** are backed up and written to the database's `Templates/` folder.
- **Comments** (optional): page and block comments (needs the "Read comments" capability).
- **Re-sync by `notion-id`**: pages you moved or renamed in the vault are updated in their new place, never duplicated.
- **Quick incremental sync**: only reads what changed; a **full verification** runs automatically every 5th run or after 7 days.
- **Conflicts**: pages edited on both sides open a dialog; local is kept by default and the Notion version is saved to `_同步冲突/` ("sync conflicts").
- **Local edit backups**: before a local edit is overwritten it is copied to `_本地修改备份/<time>/` ("local edit backups").
- **Deleted in Notion**: moved to `_已在Notion删除/` ("deleted in Notion"), only when the crawl was complete.
- **Resume**: if the network drops or Obsidian is closed mid-import, the next run continues where it stopped.
- **Import report**: compares Notion with the vault item by item (pages, blocks, property values, attachments, raw JSON); failed requests and downloads are listed at the top.

### Notion mode (toggle any time; turning it off restores stock Obsidian)
- **Page tree sidebar**: a folder and its same-name note become one "page", databases are rows; favourites, drag to reorganise, ··· menu, long-press menu.
- **Twemoji icons**: bundled Twemoji images for emoji (no more boxes on Windows), icon picker with English and Chinese search; page icons in the file list, tabs, internal links and Bases cells.
- **Covers and icons** above the page, click to change.
- **"/" block menu**, also triggered by `、` and full-width `／` from Chinese input methods: headings, to-dos, toggles, callouts, columns, table of contents, databases…
- **@ mentions** of pages and dates (also full-width `＠`).
- **Block handles `＋` / `⋮⋮`**: drag blocks (also onto a page in the tree); menu with delete, duplicate, turn into, colour, turn into page, move to.
- **Block shortcuts**: see the [table below](#shortcuts-in-notion-mode).
- **Calendar**: drag to change dates; drag rows from a table / board / gallery onto the calendar (`Ctrl+Z` undoes); rows without a date are listed under 「无日期」 ("no date").
- **Board**: drag cards between columns.
- **Table**: click a coloured select / multi-select / status cell to pick from a dropdown.
- **Side peek**: clicking a database row opens it in a split on the right.
- **Naming**: new pages / rows are called 「无标题」 ("Untitled"), 「无标题 2」…
- **Page settings** in the page ··· menu: full width, font, small text, lock.
- **Compatibility self-check**: the private Obsidian internals the plugin uses are probed at startup; Settings → 兼容性 ("compatibility") shows ✓ / ⚠, and a broken one falls back to stock Obsidian behaviour.

## Requirements
- Obsidian **1.15 (recommended, tested)**; minimum **1.10**; board views need **1.14+**.
- The **Bases** core plugin must be enabled.
- Desktop: tested on Linux and Windows 11 (macOS untested, expected to work). Mobile: loads; touch only tested in simulation.
- Network access to `api.notion.com`.

## Installation

### Manual (recommended)
1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/Destrudos6/obsidian-notion-lookalike/releases).
2. Put them in `<your vault>/.obsidian/plugins/notion-lookalike-importer/` (`.obsidian` is a hidden folder).
3. Obsidian → Settings → Community plugins → turn off Restricted mode → reload → enable **Notion Look-alike Importer**.

### BRAT (optional)
With the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin installed, choose "Add Beta plugin" and enter `Destrudos6/obsidian-notion-lookalike`.

> The plugin is not (yet) in the official Obsidian community plugin list.

## Setting up the Notion integration
One time only.
1. Open <https://www.notion.so/profile/integrations> → **New integration**, type **Internal**, pick your workspace.
2. Under Capabilities enable **only "Read content"**. Add "Read comments" if you want comments backed up. Do **not** grant update / insert content — the plugin never needs it.
3. Copy the **Internal integration secret** (starts with `ntn_`).
4. In Notion, open each top-level page you want to back up → `···` → **Connections** → add your integration. Sub-pages are included automatically.
5. Obsidian → Settings → Notion Look-alike Importer → paste the secret into **Notion integration token**.

## Usage

### First import
1. Optionally set "要导入的页面" (pages to import — one page link or ID per line; empty = everything the integration can see) and "目标文件夹" (target folder, default `Notion`).
2. Open the command palette (`Ctrl+P`; `Ctrl+Shift+P` in Notion mode) and run **Import from Notion (API, keep look)**.
3. Wait (roughly 15–20 minutes for ~1000 pages). Interruptions are fine — run it again to resume.
4. Open `Notion/_导入报告` (import report). A complete backup has ✓ on every line.

### Re-sync
- **Import from Notion** — a **quick sync** by default: only reads what changed.
- **完整校验同步 / Full verification re-sync** — re-reads and verifies everything.
- **Rebuild notes from the raw Notion backup (offline)** — regenerates notes from `_raw/` without network.

Your edits in Obsidian are never lost:

| Situation | What the plugin does |
|---|---|
| Edited only in Obsidian | Keeps your version |
| Edited in both | Conflict dialog, local kept by default; Notion's version saved to `_同步冲突/` |
| A local edit must be overwritten | The local version is first copied to `_本地修改备份/<time>/` |
| Page deleted in Notion | Moved to `_已在Notion删除/` (only after a complete crawl) |
| Page moved / renamed in the vault | Updated in its new place, no duplicate |

### Stop syncing
When you have moved over for good, enable **「搬家完成，停止从 Notion 同步」** ("migration done, stop syncing from Notion"). The plugin then never contacts Notion or overwrites anything; everything in the vault stays. You can switch it back any time.

### Notion mode
Run **切换 Notion 模式 / Toggle Notion mode** (or use the setting). Turning it off restores hotkeys, the file explorer and settings; no files are changed. Vaults with an import turn Notion mode on automatically.

## Folder layout
With the default target folder `Notion`:

```
Notion/
├── My page.md                  ← a Notion page
├── My page/                    ← its sub-pages and files
│   ├── Sub page.md
│   └── Tasks/                  ← a database
│       ├── Tasks.base          ← the database (Bases, all views)
│       ├── Some row.md         ← one note per row, properties in frontmatter
│       └── Templates/          ← database templates
├── 未归类的数据库.md             ← "unsorted databases": only reachable through linked views
├── _导入报告.md                  ← import report of the last run
├── _raw/                       ← raw Notion JSON (the complete backup — keep it)
├── _attachments/               ← downloaded images and files
├── _本地修改备份/<time>/          ← local versions backed up before an overwrite
├── _同步冲突/                    ← Notion's side of a conflict
└── _已在Notion删除/              ← pages deleted in Notion
```

## Settings reference

| Setting (UI label) | What it does |
|---|---|
| Notion integration token | Read-only secret (`ntn_…`), stored in this plugin's `data.json` |
| 要导入的页面 (pages to import) | One page link or ID per line; empty = all top-level pages the integration sees |
| 目标文件夹 (target folder) | Vault folder to import into (default `Notion`) |
| 导入数据库行的正文 (row bodies) | Also import the content inside each database row |
| 备份评论 (comments) | Page and block comments (needs "Read comments"; "all" is slower) |
| 同时下载外部文件 (external files) | Also save externally linked images / files to `_attachments/external` |
| 备份数据库模板 (templates) | Read-only `GET /data_sources/{id}/templates`, written to `Templates/` |
| 同时备份 Notion 自己的 Markdown | One extra read-only request per page, saved to `_raw/markdown/` |
| 彩色标签 (coloured pills) | Show select / multi-select / status as Notion-coloured pills in Bases |
| 显示封面和图标 / 显示页面图标 | Cover banner and icon; page icons in file list, tabs, links, Bases |
| 同时把封面写进正文 | Also put the cover in the note body (visible without the plugin) |
| Notion 式视图标签 (view tabs) | Notion-style view tabs instead of the Bases view dropdown |
| 隐藏 Notion 元数据属性 | Hide `notion-id` etc. in the properties panel (data stays in the note) |
| 在文件列表中隐藏备份文件夹 | Hide `_raw` and `_attachments` in the file explorer (files stay on disk) |
| 快速同步 / 完整校验同步 | Quick sync / full verification for this run |
| 同步时的冲突处理 | Choose per page when both sides changed; local kept by default |
| 以后不再同步的页面 / 数据库 | Ignore list: skipped on sync (not overwritten, moved or deleted; raw JSON still backed up) |
| 搬家完成，停止从 Notion 同步 | Stop contacting Notion; keep everything |
| Notion 模式 / “/” 块菜单 / 块手柄 ⋮⋮ / 数据库行在侧边打开 | Notion-mode interactions |
| 用图片显示 emoji | Draw emoji with the bundled Twemoji images; off = system font |
| 兼容性 (compatibility) | Result of the private-API self-check |

## Shortcuts (in Notion mode)

| Shortcut | Action |
|---|---|
| `Ctrl+P` | Search pages |
| `Ctrl+Shift+P` | Obsidian command palette |
| `Ctrl+N` | New page |
| `Ctrl+Shift+L` | Toggle dark mode |
| `Ctrl+D` | Duplicate the current block |
| `Ctrl+Shift+↑ / ↓` | Move the current block up / down |
| `Ctrl+Shift+0`…`8` (or `Ctrl+Alt+0`…`8`) | Turn into text / H1 / H2 / H3 / to-do / bullet / numbered / toggle / code |
| `Esc` | Select the current block |
| `Ctrl+Z` (right after a calendar drop) | Undo the drop |

Use `Cmd` instead of `Ctrl` on macOS. A shortcut you already use yourself is never taken over; the settings page lists the ones that were not enabled. Turning Notion mode off restores Obsidian's default hotkeys.

## Privacy & security
- **Read-only towards Notion**: the plugin only sends `GET` requests plus `POST /search` and `POST …/query` (Notion's query endpoints, which do not modify data); anything else is refused in code (`src/api/crawler.ts`).
- **Only two kinds of hosts**: `api.notion.com` and the download URLs of images / files in your pages. Nothing is uploaded, no analytics or telemetry. Emoji images are bundled, not fetched.
- **The token stays local** in `.obsidian/plugins/notion-lookalike-importer/data.json` and is never logged. **Delete that file before sharing or publishing a vault.**
- The backup itself (`_raw/`, `_attachments/`, …) is your Notion data — treat a shared vault accordingly.

## Known limitations
- Table rows cannot be drag-reordered (Bases has no manual order).
- No new columns by dragging a block sideways; existing Notion columns render side by side but are edited as a whole.
- Timeline views are imported as tables.
- Notion's "full width" page setting is not exposed by the API; turn it on in the page ··· menu.
- Comments need the "Read comments" capability, otherwise that report line is ✗.
- All edits are local; Notion is never changed.
- Mobile only tested with simulated touch.
- Some features use undocumented Obsidian internals, each with a fallback: tree-row dragging (`app.dragManager`), block shortcuts (`editor.cm`), "/" menu group labels (EditorSuggest internals), `leaf.containerEl`, `workspace.layoutReady`, Bases `controller.view` in side peek, and others. If an Obsidian update breaks one, Settings → 兼容性 shows ⚠ and stock behaviour is used.
- Database views require the Bases core plugin.

## Development
Requires Node.js 22+ (tests use `--experimental-strip-types`).

```bash
npm install
npm run build      # type-check + bundle main.js
npm test           # unit / end-to-end tests (fictional data only)
npm run sample     # build sample-vault/ from the fictional workspace; open it in Obsidian
npm run dev        # rebuild on change
```

- Tests and the sample vault use only the **entirely fictional** Notion workspace in `test/synthetic-workspace.ts`; the repository contains no real data. Run `npm run sample` before `npm test` to include the sample-vault check (skipped otherwise).
- To debug against your own workspace: `NOTION_TOKEN=ntn_… node --experimental-strip-types scripts/live-backup.ts <vault dir>` (read-only). Please never commit your own backups (`fixtures/`, `live/`, `sample-vault/` and `data.json` are git-ignored).
- `src/generated/emoji-pack.ts` is generated by `scripts/emoji/build-emoji-pack.py` from Twemoji and emojibase-data.

Layout: `src/api` (read-only crawler), `src/core` (conversion, formulas, views, sync plan), `src/pipeline.ts` (crawl → raw → convert → sync → verify), `src/notion` (Notion-mode interactions), `src/render` (custom views).

## Contributing
Issues and pull requests are welcome. For bug reports include your Obsidian version, OS and the failing lines of the import report (**remove anything private**) — never your `data.json` or token. Please keep `npm run build` and `npm test` passing and use fictional content in tests.

## License
- Code: [MIT](LICENSE) © 2026 Destrudos6.
- Bundled emoji graphics: **Twemoji** (© Twitter, Inc and other contributors, jdecked/twemoji v17.0.3), licensed [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Emoji names / keywords: emojibase-data (MIT), derived from Unicode CLDR (Unicode License v3).
- Other projects this work draws on (obsidian-importer, react-notion-x, GoodBases, N2O Lite, Calm Page) and full license texts: [`LICENSES/`](LICENSES/).

Not affiliated with Notion Labs or Obsidian.
