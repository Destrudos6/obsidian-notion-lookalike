/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion "/" block menu (EditorSuggest, public API). Inserts the SAME Markdown conventions the importer writes,
// so new content and imported content look and behave the same:
//   toggle  > [!toggle]- title          toggle heading  > [!toggle-h2]- title
//   callout > [!notion-callout|gray-bg] 💡   columns  > [!notion-columns|2] / > > [!notion-column]
//   page    [[sub-page]] (a new note in the page's folder)   database  ![[X.base]] (X/X.base, rows = notes in X/)
//   link to page  ↗ [[page]]     table of contents  ```notion-toc```
import { type App, type Editor, type EditorPosition, EditorSuggest, type EditorSuggestContext, type EditorSuggestTriggerInfo, Notice, TFile, setIcon } from 'obsidian';
import type { NotionHost } from './host.ts';
import { PageSearchModal } from './search.ts';
import { ensureFolder, uniquePath, type PageNode } from './pages.ts';
import { UNTITLED } from '../core/naming.ts';
import { CUR, MD } from './blocks-md.ts';
import { slashTrigger, inBlockCode } from './trigger.ts';

interface SlashItem {
	id: string; name: string; en: string; desc: string; icon: string; group: string; keys: string; hint?: string;
	run: (s: SlashCtx) => void | Promise<void>;
	hiddenUnlessQuery?: boolean;
	swatch?: string;
}
interface SlashCtx { app: App; host: NotionHost; editor: Editor; file: TFile; line: number; prefix: string; empty: boolean }

/** cursor marker inside inserted text (a private-use character, never in user text) */
const C = CUR;

const COLORS: [string, string, string][] = [
	['gray-bg', '灰色', 'gray'], ['brown-bg', '棕色', 'brown'], ['orange-bg', '橙色', 'orange'], ['yellow-bg', '黄色', 'yellow'], ['green-bg', '绿色', 'green'],
	['blue-bg', '蓝色', 'blue'], ['purple-bg', '紫色', 'purple'], ['pink-bg', '粉色', 'pink'], ['red-bg', '红色', 'red'], ['plain', '无背景（边框）', 'default border'],
];

/** Write `lines` at the slash position: the current line is replaced when it is empty (Notion "turn into"),
 *  otherwise the block goes on a new line below. `prefix` (quote / callout nesting "> ") is kept on every line.
 *  The cursor ends at the C marker, which is removed. */
function put(s: SlashCtx, lines: string[], opts: { blankBefore?: boolean } = {}) {
	const { editor, line, prefix } = s;
	let text = lines.map(l => (prefix + l).replace(/\s+$/, m => (l.endsWith(' ') ? m : ''))).join('\n');
	if (opts.blankBefore && !s.empty && !prefix) text = '\n' + text;
	const cur = editor.getLine(line);
	let from: EditorPosition, to: EditorPosition;
	if (s.empty) { from = { line, ch: 0 }; to = { line, ch: cur.length }; }
	else { from = { line, ch: cur.length }; to = from; text = '\n' + text; }
	const at = text.indexOf(C);
	const clean = at >= 0 ? text.slice(0, at) + text.slice(at + 1) : text;
	editor.replaceRange(clean, from, to);
	const off = editor.posToOffset(from) + (at >= 0 ? at : clean.length);
	editor.setCursor(editor.offsetToPos(off));
	editor.focus();
}

function pickFile(accept: string): Promise<File | null> {
	return new Promise(res => { const i = createEl('input', { attr: { type: 'file', accept } }); i.onchange = () => res(i.files?.[0] ?? null); i.click(); });
}

async function upload(s: SlashCtx, accept: string) {
	const f = await pickFile(accept);
	if (!f) return;
	const name = (f.name || 'file').replace(/[\\/:*?"<>|#^[\]]/g, '-');
	const path = await s.app.fileManager.getAvailablePathForAttachment(name, s.file.path);
	const created = await s.app.vault.createBinary(path, await f.arrayBuffer());
	put(s, [s.app.fileManager.generateMarkdownLink(created, s.file.path).replace(/^\[\[/, '![[').replace(/^\[/, '![').replace(/^!!/, '!') + C]);
}

/** folder that holds the current page's sub-pages (P.md → P/), created on demand — nothing is moved */
async function ownFolder(s: SlashCtx): Promise<string> {
	const f = s.file;
	const dir = f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '';
	return (await ensureFolder(s.app, dir + f.basename)).path;
}

async function newDatabase(s: SlashCtx) {
	const folder = await ownFolder(s);
	const dbPath = uniquePath(s.app, folder, '新数据库', 'base');
	const name = dbPath.slice(dbPath.lastIndexOf('/') + 1, -5);
	const dbFolder = (await ensureFolder(s.app, `${folder}/${name}`)).path;
	const q = (x: string) => JSON.stringify(x);
	const base = [
		'notion:', `  icon: 🗃️`, 'filters:', '  and:', `    - ${q(`file.folder == ${q(dbFolder)}`)}`, `    - ${q('file.ext == "md"')}`,
		'properties:', '  file.name:', '    displayName: 名称', 'views:', '  - type: table', '    name: 表格', '    order:', '      - file.name', '',
	].join('\n');
	const file = await s.app.vault.create(`${dbFolder}/${name}.base`, base);
	// one empty row so the table is not blank (Notion starts with three; one is enough to show where rows live)
	await s.app.vault.create(uniquePath(s.app, dbFolder, UNTITLED, 'md'), '');
	put(s, [`![[${file.path}]]`, C]);
}

const ITEMS: SlashItem[] = [
	// 基础块
	{ id: 'text', name: '文本', en: 'Text', desc: '开始输入纯文本。', icon: 'type', group: '基础块', keys: 'text paragraph wenben wb 段落', run: s => put(s, [C]) },
	{ id: 'page', name: '页面', en: 'Page', desc: '在此页面中嵌入一个子页面。', icon: 'file-text', group: '基础块', keys: 'page subpage yemian ym 子页面', run: async s => {
		const node: PageNode | null = s.host.model.nodeForFile(s.file);
		const child = await s.host.newPage(node, { link: false });
		if (!child) return;
		put(s, [s.app.fileManager.generateMarkdownLink(child, s.file.path) + C]);
	} },
	{ id: 'todo', name: '待办清单', en: 'To-do list', desc: '用待办清单跟踪任务。', icon: 'check-square', group: '基础块', keys: 'todo checkbox task daiban db 任务 复选框', hint: '[]', run: s => put(s, ['- [ ] ' + C]) },
	{ id: 'h1', name: '标题 1', en: 'Heading 1', desc: '大号章节标题。', icon: 'heading-1', group: '基础块', keys: 'h1 heading1 title biaoti bt 标题', hint: '#', run: s => put(s, ['# ' + C]) },
	{ id: 'h2', name: '标题 2', en: 'Heading 2', desc: '中号章节标题。', icon: 'heading-2', group: '基础块', keys: 'h2 heading2 biaoti bt 标题', hint: '##', run: s => put(s, ['## ' + C]) },
	{ id: 'h3', name: '标题 3', en: 'Heading 3', desc: '小号章节标题。', icon: 'heading-3', group: '基础块', keys: 'h3 heading3 biaoti bt 标题', hint: '###', run: s => put(s, ['### ' + C]) },
	{ id: 'table', name: '表格', en: 'Table', desc: '在页面中添加简单表格。', icon: 'table', group: '基础块', keys: 'table biaoge bg', run: s => put(s, [`| ${C} |  |`, '| --- | --- |', '|  |  |'], { blankBefore: true }) },
	{ id: 'bullet', name: '项目符号列表', en: 'Bulleted list', desc: '创建简单的项目符号列表。', icon: 'list', group: '基础块', keys: 'bullet list ul liebiao lb 无序 列表', hint: '-', run: s => put(s, ['- ' + C]) },
	{ id: 'number', name: '编号列表', en: 'Numbered list', desc: '创建带编号的列表。', icon: 'list-ordered', group: '基础块', keys: 'number numbered ol bianhao bh 有序 列表', hint: '1.', run: s => put(s, ['1. ' + C]) },
	{ id: 'toggle', name: '折叠列表', en: 'Toggle list', desc: '折叠列表可以隐藏和显示里面的内容。', icon: 'chevron-right', group: '基础块', keys: 'toggle fold zhedie zd 折叠 开关', hint: '>', run: s => put(s, MD.toggle()) },
	{ id: 'quote', name: '引述', en: 'Quote', desc: '记录引用。', icon: 'quote', group: '基础块', keys: 'quote blockquote yinyong yy 引用 引述', hint: '"', run: s => put(s, ['> ' + C]) },
	{ id: 'divider', name: '分割线', en: 'Divider', desc: '在视觉上分隔块。', icon: 'minus', group: '基础块', keys: 'divider hr line fengexian fgx 分隔', hint: '---', run: s => put(s, ['---', C], { blankBefore: true }) },
	{ id: 'link', name: '链接到页面', en: 'Link to page', desc: '链接到一个已有页面。', icon: 'corner-up-right', group: '基础块', keys: 'link page mention lianjie lj 链接 引用页面', run: s => {
		new PageSearchModal(s.app, s.host, { title: '链接到页面…', onPick: n => { if (n?.file) put(s, MD.linkToPage(s.app.fileManager.generateMarkdownLink(n.file, s.file.path))); } }).open();
	} },
	{ id: 'callout', name: '标注', en: 'Callout', desc: '让文字更醒目。输入“标注 颜色”选择底色。', icon: 'message-square-warning', group: '基础块', keys: 'callout biaozhu bz 标注 提示 highlight', run: s => put(s, MD.callout()) },
	...COLORS.map(([meta, zh, en]): SlashItem => ({
		id: 'callout-' + meta, name: `标注（${zh}）`, en: `Callout (${en})`, desc: `${zh}的标注块。`, icon: 'message-square-warning', group: '基础块',
		keys: `callout ${en} biaozhu bz 标注 ${zh}`, hiddenUnlessQuery: true, swatch: meta === 'plain' ? undefined : `var(--n-bg-${meta.replace('-bg', '')})`, run: s => put(s, MD.callout(meta)),
	})),
	{ id: 'th1', name: '折叠标题 1', en: 'Toggle heading 1', desc: '可以折叠的大号标题。', icon: 'heading-1', group: '基础块', keys: 'toggle heading h1 zhedie biaoti 折叠标题', run: s => put(s, MD.toggle(1)) },
	{ id: 'th2', name: '折叠标题 2', en: 'Toggle heading 2', desc: '可以折叠的中号标题。', icon: 'heading-2', group: '基础块', keys: 'toggle heading h2 zhedie biaoti 折叠标题', run: s => put(s, MD.toggle(2)) },
	{ id: 'th3', name: '折叠标题 3', en: 'Toggle heading 3', desc: '可以折叠的小号标题。', icon: 'heading-3', group: '基础块', keys: 'toggle heading h3 zhedie biaoti 折叠标题', run: s => put(s, MD.toggle(3)) },
	// 媒体
	{ id: 'image', name: '图片', en: 'Image', desc: '上传图片（保存到附件文件夹）。', icon: 'image', group: '媒体', keys: 'image picture photo tupian tp 图片 照片', run: s => upload(s, 'image/*') },
	{ id: 'file', name: '文件', en: 'File', desc: '上传任意文件。', icon: 'paperclip', group: '媒体', keys: 'file upload attachment wenjian wj 文件 附件', run: s => upload(s, '*/*') },
	{ id: 'code', name: '代码', en: 'Code', desc: '记录代码片段。', icon: 'code', group: '媒体', keys: 'code snippet daima dm 代码', hint: '```', run: s => put(s, ['```', C, '```']) },
	// 数据库
	{ id: 'db-new', name: '数据库 - 内嵌', en: 'Database - Inline', desc: '在此页面内新建一个表格数据库（Bases）。', icon: 'table-2', group: '数据库', keys: 'database inline table base shujuku sjk 数据库 表格 内嵌', run: s => newDatabase(s) },
	{ id: 'db-link', name: '链接已有数据库', en: 'Linked view of data source', desc: '嵌入库里已有的数据库（.base）。', icon: 'database', group: '数据库', keys: 'linked database view base shujuku sjk 数据库 链接', run: s => {
		new PageSearchModal(s.app, s.host, { title: '选择要嵌入的数据库…', onPick: n => {
			if (!n?.file) return;
			if (n.file.extension !== 'base') { new Notice('请选择一个数据库（.base）'); return; }
			put(s, [`![[${n.file.path}]]`, C]);
		} }).open();
	} },
	// 高级
	{ id: 'col2', name: '2 栏', en: '2 columns', desc: '创建 2 栏并排的内容。', icon: 'columns-2', group: '高级块', keys: 'columns column 2 fenlan fl 分栏 两栏', run: s => put(s, MD.columns(2)) },
	{ id: 'col3', name: '3 栏', en: '3 columns', desc: '创建 3 栏并排的内容。', icon: 'columns-3', group: '高级块', keys: 'columns column 3 fenlan fl 分栏 三栏', run: s => put(s, MD.columns(3)) },
	{ id: 'toc', name: '目录', en: 'Table of contents', desc: '显示页面标题的大纲。', icon: 'list-tree', group: '高级块', keys: 'toc contents mulu ml 目录 大纲', run: s => put(s, MD.toc()) },
	{ id: 'equation', name: '公式块', en: 'Block equation', desc: '显示一个数学公式。', icon: 'sigma', group: '高级块', keys: 'equation math latex gongshi gs 公式 数学', run: s => put(s, ['$$', C, '$$']) },
];

/** menu items matching a query (empty query → all visible items) */
export function matchItems(query: string): SlashItem[] {
		const q = query.trim().toLowerCase();
		if (!q) return ITEMS.filter(i => !i.hiddenUnlessQuery);
		const words = q.split(/\s+/);
		const scored = ITEMS.map(i => {
			const hay = `${i.name} ${i.en} ${i.keys}`.toLowerCase();
			if (!words.every(w => hay.includes(w))) return null;
			const n = `${i.name} ${i.en}`.toLowerCase();
			const score = (n.startsWith(q) ? 3 : 0) + (n.includes(q) ? 2 : 0) + (i.hiddenUnlessQuery ? -1 : 0);
			return { i, score };
		}).filter((x): x is { i: SlashItem; score: number } => !!x);
		// a colour word only shows the coloured callouts
		return scored.sort((a, b) => b.score - a.score).map(x => x.i);
	}
export const SLASH_ITEM_NAMES = () => ITEMS.map(i => i.name);

export class SlashMenu extends EditorSuggest<SlashItem> {
	host: NotionHost;
	enabled: () => boolean;
	constructor(app: App, host: NotionHost, enabled: () => boolean) {
		super(app);
		this.host = host; this.enabled = enabled;
		this.limit = 60;
		this.setInstructions([{ command: '↑↓', purpose: '选择' }, { command: '↵', purpose: '插入' }, { command: 'Esc', purpose: '关闭' }]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!this.enabled() || !file) return null;
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const t = slashTrigger(before);
		if (!t) return null;
		if (inBlockCode(i => editor.getLine(i), cursor.line)) return null;
		// no match → no menu, the typed text (e.g. a normal 、) stays as it is
		if (t.query && !matchItems(t.query).length) return null;
		return { start: { line: cursor.line, ch: t.start }, end: cursor, query: t.query };
	}

	getSuggestions(ctx: EditorSuggestContext): SlashItem[] { return matchItems(ctx.query); }

	renderSuggestion(item: SlashItem, el: HTMLElement) {
		el.addClass('n-slash-item');
		const list = (this as any).suggestions?.values as SlashItem[] | undefined;
		const idx = list ? list.indexOf(item) : -1;
		if (!(this as any).context?.query && (idx === 0 || (idx > 0 && list![idx - 1].group !== item.group))) el.setAttr('data-group', item.group);
		const ic = el.createDiv({ cls: 'n-slash-icon' });
		setIcon(ic, item.icon);
		if (item.swatch) ic.style.background = item.swatch;
		const t = el.createDiv({ cls: 'n-slash-text' });
		t.createDiv({ cls: 'n-slash-name', text: item.name });
		t.createDiv({ cls: 'n-slash-desc', text: item.desc });
		if (item.hint) el.createDiv({ cls: 'n-slash-hint', text: item.hint });
	}

	selectSuggestion(item: SlashItem) {
		const ctx = this.context;
		if (!ctx) return;
		const { editor, file, start, end } = ctx;
		editor.replaceRange('', start, end);
		const line = editor.getLine(start.line);
		const pm = line.match(/^((?:>\s?)*)/);
		const prefix = pm && pm[1] ? pm[1].replace(/\s?$/, ' ') : '';
		// the remaining line content (without quote nesting / list markers) decides "turn into" vs "insert below"
		const rest = line.slice(pm ? pm[1].length : 0).replace(/^(\s*([-*+]|\d+[.)])\s+(\[.\]\s+)?|#{1,6}\s+)/, '').trim();
		this.close();
		void item.run({ app: this.app, host: this.host, editor, file, line: start.line, prefix, empty: rest === '' });
	}
}
