# Third-party notices

| File | Project | Used for |
|---|---|---|
| obsidian-importer-MIT.txt | obsidianmd/obsidian-importer (MIT) | formula function table (src/core/formula.ts); database templates endpoint usage (`GET /data_sources/{id}/templates`, idea from `database-helpers.ts`) |
| GoodBases-MIT.txt | FrancescoUmberto/GoodBases (MIT) | idea for the gray icon-only Bases toolbar + blue "New" button (styles.css, "Round 5: Notion chrome layer") |
| n2o-lite-MIT.txt | n2osync/n2o-lite (MIT) | solid rotating toggle triangle (styles.css) |
| calm-page-MIT.txt | jrayas/obsidian-calm-page (MIT) | Notion palette / page-column reference (styles.css) |
| react-notion-x-MIT.txt | NotionX/react-notion-x (MIT) | metrics: page width, full-width padding, quote 1.2em, callout radius 3px, page icon 78 px emoji / 124 px image (styles.css) |
| twemoji-LICENSE-GRAPHICS.txt | jdecked/twemoji v17.0.3 — emoji **graphics**, CC-BY 4.0 | bundled emoji SVGs (src/generated/emoji-pack.ts, built by scripts/emoji/build-emoji-pack.py): page icons, icon picker, emoji in notes |
| twemoji-MIT.txt | jdecked/twemoji v17.0.3 — **code**, MIT | file-name rule for emoji → SVG (FE0F dropped unless ZWJ), src/emoji.ts |
| emojibase-MIT.txt | milesj/emojibase — emojibase-data (MIT) | emoji names, groups and keywords (English + Chinese) for the icon picker search |
| unicode-cldr-LICENSE.txt | Unicode CLDR (Unicode License v3) | the emojibase-data names/keywords are derived from CLDR annotations |

No code was copied verbatim from GoodBases, N2O Lite, Calm Page or react-notion-x; CSS values and techniques were re-implemented. Notices are kept because the work is derived from them.

## Emoji attribution (CC-BY 4.0 requires it)

Emoji graphics: **Twemoji** — Copyright 2020 Twitter, Inc and other contributors; maintained fork jdecked/twemoji v17.0.3
(https://github.com/jdecked/twemoji). Graphics licensed under CC-BY 4.0: https://creativecommons.org/licenses/by/4.0/ .
The SVGs were not modified except for stripping the outer `<svg>` wrapper for packing (re-added at render time).
Twemoji code: MIT (Copyright 2022–present Jason Sofonia & Justine De Caires; 2014–2021 Twitter).
Emoji names/keywords: emojibase-data (MIT, Miles Johnson), derived from Unicode CLDR data (Copyright © Unicode, Inc., Unicode License v3).
The same attribution is shown in the plugin settings under “用图片显示 emoji”.
