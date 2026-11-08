# Notion Look-alike Importer（Obsidian 插件）

**中文** | [English](README.en.md)

把 Notion 工作区**只读地、完整地**备份到 Obsidian，并尽量保留 Notion 的样子；再加一个「Notion 模式」，让一个人用 Obsidian 时手感接近 Notion。

设计的第一原则是**数据不丢**：插件从不修改 Notion；本地的修改在同步前一定先备份；Notion 里删掉的页面只会被移走，不会被删除。

> 当前版本 v1.0.0。这是个人项目，桌面端在 Linux 和 Windows 11 上测试过；手机端只做过模拟触摸测试，没有真机测试。

---

## 目录
- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [准备 Notion integration](#准备-notion-integration)
- [使用](#使用)
- [库里的文件夹结构](#库里的文件夹结构)
- [设置说明](#设置说明)
- [快捷键](#快捷键notion-模式下)
- [隐私与安全](#隐私与安全)
- [已知限制](#已知限制)
- [开发](#开发)
- [参与贡献](#参与贡献)
- [许可](#许可)

## 功能

### 导入 / 备份（单向，只读）
- **页面和数据库**：页面 → Markdown 笔记；数据库 → Obsidian **Bases**（`.base` 文件），每一行是一条笔记，属性写在 frontmatter 里。
- **所有视图**：表格、看板、画廊、列表、日历、图表、表单都会转换，保持 Notion 里的视图顺序；链接视图（linked view）只带它自己的那些视图。时间线视图导入为表格。
- **属性**：标题、文本、数字、单选 / 多选 / 状态（带 Notion 颜色）、日期（含时间、时区、范围）、人员、文件、复选框、URL、邮箱、电话、关系（relation，超过 25 条也会补全）等；不认识的类型以 JSON 原样保留。
- **公式和汇总（rollup）**：能翻译的转成**实时的 Bases 公式**；不能翻译的写入 Notion 算好的值，并在报告里注明原因。
- **附件**：Notion 托管的图片、文件、封面、图标全部下载到库里（可选：外部链接的文件也存一份）。
- **原始数据层 `_raw/`**：Notion API 返回的每个页面、块、数据库的原始 JSON 都保存下来，是最完整的备份；可以随时离线重新生成笔记。
- **Notion 自己的 Markdown**（可选）：每页额外保存一份 Notion 官方导出的 Markdown，作为第二份原始备份。
- **数据库模板**：备份每个数据库的模板，生成到数据库文件夹的 `Templates/` 里。
- **评论**（可选）：页面和块上的评论（需要「读取评论」权限）。
- **再次同步按 `notion-id` 对应**：你在库里移动、改名过的页面，下次同步会在新位置更新，不会重复生成。
- **快速同步**：只读取有变化的内容；每 5 次或超过 7 天自动做一次**完整校验**。
- **冲突处理**：两边都改过的页面会弹窗选择，默认保留本地，Notion 的版本另存到 `_同步冲突/`。
- **本地修改备份**：覆盖本地修改前，先复制到 `_本地修改备份/<时间>/`。
- **Notion 里删除的页面**：移到 `_已在Notion删除/`，不直接删除（只有抓取完整时才这样做）。
- **断点续传**：中途断网或关掉 Obsidian，再运行一次会从断点继续。
- **导入报告**：逐项核对 Notion 与库里的页面、块、属性值、附件、原始 JSON 数量，任何失败的请求和下载都列在最上面。

### Notion 模式（可随时开关，关掉即恢复原样）
- **页面树侧边栏**：文件夹和同名笔记合成一个「页面」，数据库显示为一行；收藏、拖动整理、··· 菜单、长按菜单。
- **Twemoji 图标**：内置 Twemoji 图片显示 emoji（Windows 上不再是方框），图标选择器支持中英文搜索；文件列表、标签页、内部链接、Bases 单元格前都显示页面图标。
- **封面和图标**：页面上方显示封面横幅和图标，点击可更换。
- **「/」块菜单**：也支持中文输入法下的 `、` 和全角 `／`；标题、待办、折叠列表、标注、分栏、目录、数据库……
- **@ 提及**：提及页面或日期（也支持全角 `＠`）。
- **块手柄 `＋` / `⋮⋮`**：拖动移动块（也可以拖到页面树里的页面上）；菜单里有删除、复制、转换为、颜色、转为页面、移动到。
- **块快捷键**：见下面的[快捷键表](#快捷键notion-模式下)。
- **日历**：拖动改日期；把表格 / 看板 / 画廊里的行拖到日历上（`Ctrl+Z` 撤销）；没有日期的行显示在「无日期」列表里。
- **看板**：拖卡片换列。
- **表格**：点彩色单选 / 多选 / 状态格子直接下拉选择。
- **侧边预览**：点数据库行在右侧打开，不替换当前页面。
- **新页面命名**：新建页面 / 行统一叫「无标题」「无标题 2」……
- **页面设置**：页面 ··· 菜单里的全宽 / 字体 / 小字号 / 锁定。
- **兼容性自检**：插件用到的 Obsidian 未公开接口在启动时自检，设置页最下面「兼容性」会显示 ✓ / ⚠；失效时自动退回 Obsidian 原来的行为。

## 环境要求
- Obsidian **1.15（推荐，已测试）**；最低 **1.10**；看板视图需要 **1.14+**。
- 需要开启 Obsidian 核心插件 **Bases（数据库）**。
- 桌面端：Linux、Windows 11 测试过（macOS 未测试，理论上可用）。手机端：可以加载，触摸操作只做过模拟测试。
- 一个能访问 `api.notion.com` 的网络。

## 安装

### 手动安装（推荐）
1. 打开本仓库的 [Releases](https://github.com/Destrudos6/obsidian-notion-lookalike/releases)，下载最新版本的 `main.js`、`manifest.json`、`styles.css`。
2. 在你的库里建文件夹 `.obsidian/plugins/notion-lookalike-importer/`（`.obsidian` 是隐藏文件夹），把这三个文件放进去。
3. Obsidian → 设置 → 第三方插件 → 关闭「安全模式」→ 刷新列表 → 打开 **Notion Look-alike Importer**。

### 用 BRAT 安装（可选）
装好社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 后，选 “Add Beta plugin”，填入 `Destrudos6/obsidian-notion-lookalike`。

> 本插件暂未提交到 Obsidian 官方社区插件列表。

## 准备 Notion integration
只需要做一次。
1. 浏览器打开 <https://www.notion.so/profile/integrations> → **新建 integration**，类型选 **内部（Internal）**，选择你的工作区。
2. 在「功能 / Capabilities」里**只勾「读取内容」（Read content）**。想备份评论的话，再勾「读取评论」（Read comments）。**不要**给「更新内容」「插入内容」权限——插件用不到。
3. 复制「内部 integration 密钥」（以 `ntn_` 开头）。
4. 在 Notion 里打开要备份的最上层页面 → 右上角 `···` → **连接（Connections）** → 选刚建的 integration。子页面会自动包含；有多个最上层页面就每个都连接一次。
5. Obsidian → 设置 → Notion Look-alike Importer → 把密钥粘贴到 **Notion integration token**。

## 使用

### 第一次导入
1. （可选）在设置里填写「要导入的页面」（每行一个页面链接或 ID，留空 = integration 能看到的全部）和「目标文件夹」（默认 `Notion`）。
2. 打开命令面板（`Ctrl+P`；Notion 模式下是 `Ctrl+Shift+P`），运行 **Import from Notion (API, keep look)**。
3. 等待完成（大约 1000 个页面需要 15–20 分钟）。中途断网或关掉 Obsidian 没关系，再运行一次会从断点继续。
4. 打开 `Notion/_导入报告`，每一行都是 ✓ 才是完整备份。

### 再次同步
- **Import from Notion**：默认是**快速同步**，只读取有变化的内容。
- **完整校验同步 / Full verification re-sync**：重新读取全部内容并核对一遍，怀疑有遗漏时用。
- **Rebuild notes from the raw Notion backup (offline)**：不联网，按 `_raw/` 里的原始数据重新生成笔记。

同步时你在 Obsidian 里做的修改不会丢：

| 情况 | 插件怎么做 |
|---|---|
| 只在 Obsidian 改了 | 保留你的版本 |
| Obsidian 和 Notion 都改了 | 弹出冲突窗口，默认保留本地；Notion 的版本另存到 `_同步冲突/` |
| 需要覆盖本地修改时 | 先把本地版本复制到 `_本地修改备份/<时间>/` |
| Notion 里删除了页面 | 移到 `_已在Notion删除/`（只在抓取完整时） |
| 你在库里移动或改名了页面 | 下次同步在新位置更新，不重复生成 |

### 停止同步
搬家完成后，在设置里打开 **「搬家完成，停止从 Notion 同步」**。之后插件不再连接 Notion，也不会覆盖任何文件，库里的内容全部保留；随时可以关掉恢复。

### Notion 模式
运行命令 **切换 Notion 模式 / Toggle Notion mode**（或在设置里打开）。关掉后快捷键、文件列表、设置全部还原，文件不会被修改。导入过 Notion 的库会自动打开 Notion 模式。

## 库里的文件夹结构
以默认目标文件夹 `Notion` 为例：

```
Notion/
├── 我的页面.md                 ← 一个 Notion 页面
├── 我的页面/                   ← 它的子页面、附件
│   ├── 子页面.md
│   └── 任务/                   ← 一个数据库
│       ├── 任务.base           ← 数据库本体（Bases，含所有视图）
│       ├── 某一行.md           ← 每行一条笔记，属性在 frontmatter
│       └── Templates/          ← 数据库模板
├── 未归类的数据库.md            ← 只能通过链接视图访问到的数据库（原页面没共享给 integration）
├── _导入报告.md                 ← 每次同步的核对结果
├── _raw/                       ← Notion 原始 JSON（最完整的备份，请勿删除）
├── _attachments/               ← 下载的图片和文件
├── _本地修改备份/<时间>/         ← 覆盖前备份的本地版本
├── _同步冲突/                   ← 冲突时 Notion 那一边的版本
└── _已在Notion删除/             ← Notion 里已删除的页面
```

## 设置说明

| 设置 | 作用 |
|---|---|
| Notion integration token | 只读密钥（`ntn_…`），保存在本插件的 `data.json` |
| 要导入的页面 | 每行一个页面链接或 ID；留空 = integration 能看到的全部顶层页面 |
| 目标文件夹 | 导入到库里的哪个文件夹（默认 `Notion`） |
| 导入数据库行的正文 | 除了属性，也导入每一行页面里的内容 |
| 备份评论 | 页面和块上的评论（需要 “Read comments” 权限；“全部”会更慢） |
| 同时下载外部文件 | 外部链接的图片 / 文件也存一份到 `_attachments/external` |
| 备份数据库模板 | 只读 `GET /data_sources/{id}/templates`，生成到 `Templates/` |
| 同时备份 Notion 自己的 Markdown | 每页多一个只读请求，存到 `_raw/markdown/` |
| 彩色标签 | 在 Bases 里把单选 / 多选 / 状态显示成 Notion 颜色的标签 |
| 显示封面和图标 / 显示页面图标 | 封面横幅、图标；文件列表、标签页、链接、Bases 里的页面图标 |
| 同时把封面写进正文 | 不装插件也能看到封面（正文开头多一行图片） |
| Notion 式视图标签 | 用 Notion 式的视图标签代替 Bases 的下拉菜单 |
| 隐藏 Notion 元数据属性 | 属性面板不显示 `notion-id` 等（数据仍在笔记里） |
| 在文件列表中隐藏备份文件夹 | 不显示 `_raw`、`_attachments`（文件仍在磁盘上） |
| 快速同步 / 完整校验同步 | 只读变化 / 这次全部重读核对 |
| 同步时的冲突处理 | 两边都改过时逐个选择，默认保留本地 |
| 以后不再同步的页面 / 数据库 | 同步时跳过它们（不覆盖、不移动、不删除；原始 JSON 仍会备份） |
| 搬家完成，停止从 Notion 同步 | 不再连接 Notion，库里内容全部保留 |
| Notion 模式 / “/” 块菜单 / 块手柄 / 数据库行在侧边打开 | Notion 模式下的各项交互 |
| 用图片显示 emoji | 用内置 Twemoji 图片显示 emoji；关闭后用系统字体 |
| 兼容性 | Obsidian 内部接口自检结果 |

## 快捷键（Notion 模式下）

| 快捷键 | 作用 |
|---|---|
| `Ctrl+P` | 搜索页面 |
| `Ctrl+Shift+P` | Obsidian 命令面板 |
| `Ctrl+N` | 新建页面 |
| `Ctrl+Shift+L` | 切换深色模式 |
| `Ctrl+D` | 复制当前块（创建副本） |
| `Ctrl+Shift+↑ / ↓` | 上移 / 下移当前块 |
| `Ctrl+Shift+0`～`8`（或 `Ctrl+Alt+0`～`8`） | 转换为 文本 / 标题1 / 标题2 / 标题3 / 待办 / 项目符号 / 编号 / 折叠 / 代码 |
| `Esc` | 选中当前块 |
| `Ctrl+Z`（刚拖到日历后） | 撤销这次拖动 |

Mac 上 `Ctrl` 换成 `Cmd`。如果某个快捷键已经被你自己设置占用，插件不会抢，设置页会列出没启用的那几个。关掉 Notion 模式后所有快捷键恢复 Obsidian 默认。

## 隐私与安全
- **对 Notion 只读**：插件只发送 `GET` 请求，以及 `POST /search` 和 `POST …/query`（这两个是 Notion 的查询接口，不修改数据）；其他任何请求在代码里直接拒绝（`src/api/crawler.ts`）。
- **只连接两类地址**：`api.notion.com`，以及页面里图片 / 附件的下载地址。不上传任何内容，没有统计或遥测。emoji 图片打包在插件里，不联网下载。
- **token 只保存在本地**：保存在 `.obsidian/plugins/notion-lookalike-importer/data.json`，不会写进日志。**把库分享给别人或上传到网上之前，请先删掉这个文件。**
- 备份下来的内容（`_raw/`、`_attachments/` 等）就是你的 Notion 数据，分享库时同样注意。

## 已知限制
- 表格行不能拖动排序（Bases 没有「手动顺序」）。
- 不能把块拖到旁边新建分栏；Notion 里已有的分栏会并排显示，但只能整体编辑。
- 时间线视图导入为表格。
- 页面的「全宽」设置 Notion API 不提供，需要在页面 ··· 菜单里自己打开。
- 评论需要 integration 有「读取评论」权限，否则报告里这一行是 ✗。
- 所有编辑只在本地，Notion 始终不变。
- 手机端只做过模拟触摸测试。
- 部分功能用了 Obsidian 未公开的内部接口，都有退回方案：页面树行拖动（`app.dragManager`）、块快捷键（`editor.cm`）、「/」菜单分组标题（EditorSuggest 内部字段）、`leaf.containerEl`、`workspace.layoutReady`、侧边预览里的 Bases `controller.view` 等。Obsidian 更新后若失效，设置页「兼容性」会显示 ⚠，并自动退回 Obsidian 原来的行为。
- 数据库视图依赖 Obsidian 核心插件 Bases。

## 开发
需要 Node.js 22+（测试用到 `--experimental-strip-types`）。

```bash
npm install
npm run build      # 类型检查 + 打包出 main.js
npm test           # 单元 / 端到端测试（只用虚构数据）
npm run sample     # 用虚构工作区生成 sample-vault/，可直接用 Obsidian 打开查看效果
npm run dev        # 监听修改自动打包
```

- 测试和示例库只使用 `test/synthetic-workspace.ts` 里**完全虚构**的 Notion 工作区，仓库里没有任何真实数据。先运行 `npm run sample` 再 `npm test`，会多跑一项检查示例库的测试（否则跳过）。
- 想用自己的数据调试：`NOTION_TOKEN=ntn_… node --experimental-strip-types scripts/live-backup.ts <库文件夹>`（只读）。请不要把自己的备份提交到仓库（`.gitignore` 已排除 `fixtures/`、`live/`、`sample-vault/`、`data.json`）。
- `src/generated/emoji-pack.ts` 由 `scripts/emoji/build-emoji-pack.py` 从 Twemoji 和 emojibase-data 生成。

代码结构：`src/api`（只读抓取）、`src/core`（转换、公式、视图、备份计划）、`src/pipeline.ts`（抓取 → 原始数据 → 转换 → 同步 → 核对）、`src/notion`（Notion 模式的交互）、`src/render`（自定义视图）。

## 参与贡献
欢迎提 Issue 和 Pull Request。提交 bug 时请附上 Obsidian 版本、系统、导入报告里出错的那几行（**请删掉其中的私人内容**），不要附上 `data.json` 或 token。改动请保证 `npm run build` 和 `npm test` 通过；测试数据请使用虚构内容。

## 许可
- 代码：[MIT](LICENSE) © 2026 Destrudos6。
- 内置 emoji 图片：**Twemoji**（© Twitter, Inc 及其他贡献者，jdecked/twemoji v17.0.3），图形以 [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权。
- emoji 名称和关键词：emojibase-data（MIT），来自 Unicode CLDR（Unicode License v3）。
- 参考过的其他开源项目（obsidian-importer、react-notion-x、GoodBases、N2O Lite、Calm Page）及许可证全文见 [`LICENSES/`](LICENSES/)。

本项目与 Notion Labs 和 Obsidian 官方无关。
