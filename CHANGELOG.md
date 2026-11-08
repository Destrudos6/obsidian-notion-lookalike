# Changelog

## 1.0.0 — 2026-11-08
First public release.

### Importer (read-only)
- Pages → Markdown notes, databases → Obsidian Bases with all views (table, board, gallery, list, calendar, chart, form; timeline as table) in Notion's order; linked views keep their own views.
- Properties of every type, relations completed past 25 items, unknown types kept as JSON.
- Formulas and rollups as live Bases formulas where translatable, otherwise the stored value with a reason in the report.
- Attachments, covers and icons downloaded; optional external files.
- Raw JSON layer (`_raw/`) for every page, block and database; optional Notion Markdown copy; database templates; optional comments.
- Re-sync by `notion-id` (follows local moves / renames), quick incremental sync with automatic full verification, conflict dialog (`_同步冲突/`), local edit backups (`_本地修改备份/`), pages deleted in Notion archived (`_已在Notion删除/`), resume after interruption, ignore list, "stop syncing" switch.
- Import report comparing Notion and the vault item by item.

### Notion mode
- Page tree sidebar, Twemoji icons and icon picker, covers, "/" block menu (also `、` / `／`), @ mentions, block handles (drag / menu), block shortcuts, calendar drag and 「无日期」 list, board drag, coloured select cells in tables, side peek, 「无标题」 naming, page display settings, private-API compatibility self-check with fallbacks.

### Safety
- Only GET plus POST /search and POST …/query are ever sent to Notion; everything else is refused in code.
- Network hosts: api.notion.com and attachment URLs only. Token kept in the plugin's local data.json.
