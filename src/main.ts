/* eslint-disable @typescript-eslint/no-explicit-any */
import { App, MarkdownView, MenuItem, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, editorInfoField, normalizePath, requestUrl, type MarkdownPostProcessorContext } from 'obsidian';
import { NOTION_VERSION, parseNotionId, type Transport } from './api/crawler.ts';
import { notionIdOf } from './core/backup.ts';
import { cssClasses, setCssClass } from './core/display.ts';
import { Compat, probe } from './compat.ts';
import { serial, uniquePath } from './notion/pages.ts';
import { installRowDrag } from './notion/row-drag.ts';
import { UNTITLED, isDefaultNewName } from './core/naming.ts';
import type { EditorView } from '@codemirror/view';
import { runBlockOp, type BlockOp } from './notion/block-handles.ts';
import { TURN_KEYS } from './notion/mode.ts';
import { askConflicts } from './notion/conflict-modal.ts';
import { rebuildFromRaw, runBackup, type BackupSettings, type Fetcher, type VaultIO } from './pipeline.ts';
import { defaultTimeZone } from './core/util.ts';
import type { Row } from './render/filter.ts';
import { toDom } from './render/hnode.ts';
import { parseSpec, renderCalendar, renderChart, renderHeader } from './render/views.ts';
import { IconManager } from './icons.ts';
import { calendarHooks, registerNotionBasesViews } from './bases-views.ts';
import { EditorState } from '@codemirror/state';
import { blockHandleExtension } from './notion/block-handles.ts';
import { MentionSuggest } from './notion/mention.ts';
import { PillCellEditor } from './notion/table-edit.ts';
import { ViewTabs } from './view-tabs.ts';
import { Popover } from './notion/picker.ts';
import { LiveRefresh } from './live-refresh.ts';
import { emojiEl, emojiLoaded, emojifyText, isEmoji, loadEmoji, onEmojiReady } from './emoji.ts';
import { emojiEditorExtension } from './emoji-cm.ts';
import { NotionMode } from './notion/mode.ts';
import { PageModel, isHiddenName, type PageNode } from './notion/pages.ts';
import { SlashMenu } from './notion/slash.ts';
import type { NotionHost } from './notion/host.ts';

interface Settings {
	token: string;
	roots: string;              // one page URL / id per line (empty = everything shared with the integration)
	targetFolder: string;
	coloredPills: boolean;
	staticHeader: boolean;
	rowBodies: boolean;
	showHeader: boolean;        // draw cover + icon above notes that have them
	showIcons: boolean;         // page icons in explorer, tabs, links, Bases cells
	viewTabs: boolean;          // Notion-style view tabs instead of the Bases view dropdown
	comments: 'none' | 'pages' | 'all';   // back up Notion comments
	downloadExternal: boolean;  // keep a local copy of external (non-Notion) files too
	hideMeta: boolean;          // hide notion-url / notion-created / … in the Properties panel
	hideSystem: boolean;        // hide _raw / _attachments in the file explorer
	markdownCopy: boolean;      // also back up Notion's own Markdown rendering of each page (_raw/markdown)
	templates: boolean;         // back up database templates
	colors: Record<string, Record<string, string>>;
	baseIcons: Record<string, string>;   // .base path → database icon
	// ---- round 6: Notion mode
	notionMode?: boolean;       // undefined = automatic: on when the vault holds an import (<target>/_raw/manifest.json)
	emojiImages: boolean;       // draw emoji as Twemoji images (icons always; text emoji in notes too)
	slashMenu: boolean;         // "/" block menu (only in Notion mode)
	sidePeek: boolean;          // database rows open in a side split (only in Notion mode)
	treeOrder: Record<string, string[]>;
	treeExpanded: string[];
	recentEmoji: string[];
	// ---- round 7
	/** "以后不再同步": Notion ids the importer skips (still backed up in _raw; local files left alone) */
	ignored: { id: string; title: string; kind: 'page' | 'database' }[];
	/** pages set to read-only in the page ··· menu (path list; Notion "Lock page") */
	lockedPages: string[];
	blockHandles: boolean;      // ⋮⋮ / ＋ block handles in the editor (Notion mode)
	// ---- round 8
	/** 「搬家完成，停止从 Notion 同步」: the import / re-sync command does nothing; everything stays local */
	stopSync: boolean;
	/** quick re-sync (skip unchanged pages / databases); a full verification runs every 5th time anyway */
	incremental: boolean;
}

const DEFAULTS: Settings = {
	token: '', roots: '', targetFolder: 'Notion', coloredPills: true, staticHeader: false, rowBodies: true, showHeader: true, showIcons: true, viewTabs: true, comments: 'all', downloadExternal: true, hideMeta: true, hideSystem: true, markdownCopy: true, templates: true, colors: {}, baseIcons: {},
	emojiImages: true, slashMenu: true, sidePeek: true, treeOrder: {}, treeExpanded: [], recentEmoji: [],
	ignored: [], lockedPages: [], blockHandles: true, stopSync: false, incremental: true,
};

export default class NotionLookalikePlugin extends Plugin {
	compat = new Compat();
	/** page operations queue (tests / other features share it so moves never overlap) */
	serialPageOp = serial;
	settings: Settings = { ...DEFAULTS };
	icons!: IconManager;
	live!: LiveRefresh;
	tabs!: ViewTabs;
	/** option colors read from the `notion:` block of .base files (works without data.json) */
	private baseColors = new Map<string, Record<string, Record<string, string>>>();
	private baseStatus = new Map<string, string[]>();
	/** .base files written by the importer (have a `notion:` block) */
	private notionBases = new Set<string>();
	model!: PageModel;
	mode!: NotionMode;
	host!: NotionHost;

	/** Notion mode on? explicit setting, else automatic for vaults that hold an import */
	async notionModeWanted(): Promise<boolean> {
		if (this.settings.notionMode !== undefined) return this.settings.notionMode;
		return this.app.vault.adapter.exists(normalizePath(`${this.settings.targetFolder || 'Notion'}/_raw/manifest.json`));
	}

	async setNotionMode(on: boolean) {
		this.settings.notionMode = on;
		await this.saveSettings();
		if (on) await this.mode.enable(); else await this.mode.disable();
		this.refreshHeaders();
		this.app.workspace.updateOptions();
	}

	private makeHost(): NotionHost {
		const plugin = this;
		return {
			app: this.app, plugin: this, get icons() { return plugin.icons; }, get model() { return plugin.model; },
			get state() { return plugin.settings; },
			get compat() { return plugin.compat; },
			save: () => this.saveSettings(),
			topFolder: () => '',
			openSearch: () => this.mode.openSearch(),
			newPage: (parent: PageNode | null, opts?: { newTab?: boolean; link?: boolean }) => this.mode.newPage(parent, opts),
			openFile: async (f: TFile, newLeaf = false) => { await this.app.workspace.getLeaf(newLeaf ? 'tab' : false).openFile(f); },
			reportPath: () => { const p = normalizePath(`${this.settings.targetFolder || 'Notion'}/_导入报告.md`); return this.app.vault.getAbstractFileByPath(p) ? p : null; },
			openSettings: () => { try { const st = (this.app as any).setting; st.open(); st.openTabById(this.manifest.id); } catch { new Notice('请在 设置 → 第三方插件 里打开本插件的设置'); } },
			setNotionMode: (on: boolean) => this.setNotionMode(on),
			runCommand: (id: string) => { try { (this.app as any).commands.executeCommandById(id); } catch { /* private API */ } },
			pickPage: (title: string, cb: (n: PageNode | null) => void, exclude: PageNode | null) => this.mode.pickPage(title, cb, exclude),
			notionIdOf: (f: TFile) => this.notionIdOfFile(f),
			isIgnored: (id: string) => this.settings.ignored.some(x => x.id === id),
			setIgnored: async (f: TFile, on: boolean) => {
				const id = await this.notionIdOfFile(f);
				if (!id) return false;
				const has = this.settings.ignored.some(x => x.id === id);
				if (on && !has) this.settings.ignored.push({ id, title: f.basename, kind: f.extension === 'base' ? 'database' : 'page' });
				if (!on) this.settings.ignored = this.settings.ignored.filter(x => x.id !== id);
				await this.saveSettings();
				new Notice(on ? `“${f.basename}”以后不再从 Notion 同步（库里的文件保留，原始数据仍会备份到 _raw）` : `“${f.basename}”会在下次同步时重新从 Notion 更新`, 6000);
				return true;
			},
		} as NotionHost;
	}

	/** Notion id of an imported note (frontmatter) or database (.base `notion:` block) */
	async notionIdOfFile(f: TFile): Promise<string | null> {
		if (f.extension === 'md') {
			const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.['notion-id'];
			return id ? String(id).replace(/-/g, '').toLowerCase() : null;
		}
		if (f.extension === 'base') return notionIdOf(f.path, await this.app.vault.cachedRead(f));
		return null;
	}

	async onload() {
		this.settings = { ...DEFAULTS, ...(await this.loadData()) };
		this.addSettingTab(new NotionSettingTab(this.app, this));
		this.addCommand({ id: 'import-notion-api', name: 'Import from Notion (API, keep look)', callback: () => new ImportModal(this.app, this).open() });
		this.addCommand({ id: 'rebuild-from-raw', name: 'Rebuild notes from the raw Notion backup (offline)', callback: () => new ImportModal(this.app, this, true).open() });
		this.addCommand({ id: 'import-notion-full', name: '完整校验同步 / Full verification re-sync', callback: () => new ImportModal(this.app, this, false, true).open() });
		this.addRibbonIcon('database', 'Import from Notion (keep look)', () => new ImportModal(this.app, this).open());
		document.body.toggleClass('notion-hide-meta', this.settings.hideMeta);
		document.body.toggleClass('notion-hide-system', this.settings.hideSystem);
		this.addCommand({ id: 'toggle-full-width', name: 'Toggle Notion full width for this page', checkCallback: (checking) => {
			const f = this.app.workspace.getActiveFile();
			if (!f || f.extension !== 'md') return false;
			if (!checking) void this.app.vault.process(f, t => setCssClass(t, 'notion-full-width', !cssClasses(t).includes('notion-full-width')));   // minimal edit
			return true;
		} });

		// Notion chart / calendar views as Bases view types, and Notion-style view tabs
		registerNotionBasesViews(this);
		installRowDrag(this);   // round 8.1: table / board / gallery rows → calendar day (mouse + finger), Ctrl+Z after a drop
		// round 8.1: every new page / row is called 「无标题」(「无标题 2」…): Bases' 新建 / board ＋ make Obsidian's default name
		this.app.workspace.onLayoutReady(() => this.registerEvent(this.app.vault.on('create', f => this.renameDefaultNew(f))));
		this.tabs = new ViewTabs(this.app, this);
		this.tabs.enabled = this.settings.viewTabs;
		this.tabs.load();

		// older imports: chart / calendar as code blocks
		this.registerMarkdownCodeBlockProcessor('notion-chart', (src, el) => this.renderChart(src, el));
		this.registerMarkdownCodeBlockProcessor('notion-calendar', (src, el, ctx) => this.renderCalendar(src, el, ctx));
		this.registerMarkdownCodeBlockProcessor('notion-toc', (_src, el, ctx) => this.renderToc(el, ctx));

		// Page header (cover banner + icon), Notion style
		const refresh = () => this.refreshHeaders();
		this.registerEvent(this.app.workspace.on('layout-change', refresh));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.markBaseLeaves()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.markBaseLeaves()));
		this.registerEvent(this.app.workspace.on('resize', () => this.app.workspace.getLeavesOfType('markdown').forEach(l => this.bleed((l.view as MarkdownView).containerEl))));
		this.registerEvent(this.app.workspace.on('file-open', () => window.setTimeout(refresh, 50)));
		this.registerEvent(this.app.metadataCache.on('changed', f => { if (this.app.workspace.getLeavesOfType('markdown').some(l => (l.view as MarkdownView).file === f)) window.setTimeout(refresh, 50); }));
		this.registerMarkdownPostProcessor(() => { window.setTimeout(refresh, 0); });
		this.app.workspace.onLayoutReady(refresh);

		// Notion-style page icons (explorer, tabs, links, Bases name cells, Live Preview wikilinks)
		this.icons = new IconManager(this.app, this, () => this.settings.baseIcons, async () => this.saveSettings());
		this.icons.enabled = this.settings.showIcons;
		this.icons.onBaseMeta = (path, meta) => {
			if (meta?.colors) this.baseColors.set(path, meta.colors); else this.baseColors.delete(path);
			if (meta?.status?.length) this.baseStatus.set(path, meta.status); else this.baseStatus.delete(path);
			if (meta) this.notionBases.add(path); else this.notionBases.delete(path);
			this.markBaseLeaves();
		};
		this.icons.load();
		this.registerEditorExtension(this.icons.editorExtension());

		// live formulas: re-evaluate notes whose rollups read a note that just changed
		this.live = new LiveRefresh(this.app, this);
		this.live.load();

		// ---- round 6: emoji as images + Notion mode
		void loadEmoji();
		this.register(onEmojiReady(() => { this.refreshHeaders(); this.app.workspace.updateOptions(); }));
		this.registerMarkdownPostProcessor(el => { if (this.settings.emojiImages) { emojifyText(el); window.setTimeout(() => emojifyText(el), 0); } });
		this.registerEditorExtension(emojiEditorExtension(() => this.settings.emojiImages, () => this.icons.version + (emojiLoaded() ? 1e6 : 0)));
		this.model = new PageModel(this.app, () => normalizePath(this.settings.targetFolder || 'Notion'));
		this.host = this.makeHost();
		this.mode = new NotionMode(this.host);
		this.mode.load();
		this.registerEditorSuggest(new SlashMenu(this.app, this.host, () => this.mode.on && this.settings.slashMenu));
		// ---- round 7: block handles, "@" mentions, locked pages, calendar side peek
		this.registerEditorSuggest(new MentionSuggest(this.app, this.host, () => this.mode.on && this.settings.slashMenu));
		this.registerEditorExtension(blockHandleExtension(this.host, () => this.mode.on && this.settings.blockHandles));
		let lockNote = 0;
		this.registerEditorExtension(EditorState.transactionFilter.of(tr => {
			if (!tr.docChanged || !['input', 'delete', 'move', 'undo', 'redo'].some(e => tr.isUserEvent(e))) return tr;   // never block Obsidian's own file sync
			const f = tr.startState.field(editorInfoField, false)?.file;
			if (!f || !this.mode.isLocked(f)) return tr;
			if (Date.now() - lockNote > 3000) { lockNote = Date.now(); new Notice('页面已锁定（··· 菜单里可以解锁）'); }
			return [];
		}));
		const pills = new PillCellEditor(this.app, el => { const ctl = this.tabs.controllerOf(el); if (ctl) this.compat.mark('basesFormulas', !!ctl?.query?.formulas); return ctl; });
		this.registerDomEvent(document, 'click', ev => { pills.onClick(ev); }, { capture: true });
		// round 8: board drag hint – Bases boards have no manual order, a dropped card goes where the sort puts it
		{
			let hint: HTMLElement | null = null; let start: { x: number; y: number; card: HTMLElement } | null = null;
			const show = (card: HTMLElement) => {
				if (hint) return;
				const board = card.closest<HTMLElement>('.bases-view, .bases-kanban, .block-language-base') ?? card.parentElement!;
				hint = document.body.createDiv({ cls: 'n-board-hint', text: '按排序放置：卡片会放进你拖到的那一列，在列里的位置由当前排序决定' });
				const r = board.getBoundingClientRect();
				hint.style.left = `${Math.max(8, r.left + r.width / 2)}px`; hint.style.top = `${Math.max(8, r.top + 8)}px`;
			};
			const clear = () => { hint?.remove(); hint = null; start = null; };
			this.registerDomEvent(document, 'pointerdown', ev => { const c = (ev.target as HTMLElement).closest?.<HTMLElement>('.bases-kanban-card'); start = c && this.mode.on ? { x: ev.clientX, y: ev.clientY, card: c } : null; }, { capture: true });
			this.registerDomEvent(document, 'pointermove', ev => { if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) show(start.card); }, { capture: true });
			this.registerDomEvent(document, 'dragstart', ev => { const c = (ev.target as HTMLElement).closest?.<HTMLElement>('.bases-kanban-card'); if (c && this.mode.on) show(c); }, { capture: true });
			this.registerDomEvent(document, 'pointerup', clear, { capture: true });
			this.registerDomEvent(document, 'dragend', clear, { capture: true });
			this.registerDomEvent(document, 'drop', () => window.setTimeout(clear, 300), { capture: true });
		}
		this.registerEvent(this.app.workspace.on('layout-change', () => pills.close()));
		this.register(() => pills.close());
		// an icon / cover picker left open when the plugin is disabled: remove it and its document listeners
		this.register(() => Popover.open?.close());
		calendarHooks.peek = async (f, from) => { if (this.mode.on && this.settings.sidePeek) await this.mode.peek(f, from); else await this.app.workspace.getLeaf('tab').openFile(f); };
		this.addCommand({ id: 'toggle-notion-mode', name: '切换 Notion 模式 / Toggle Notion mode', callback: () => void this.setNotionMode(!this.mode.on) });
		this.addCommand({ id: 'notion-search', name: '搜索页面（Notion 式）/ Search pages', callback: () => this.mode.openSearch() });
		this.addCommand({ id: 'notion-new-page', name: '新建页面 / New page', callback: () => void this.mode.newPage(null) });
		this.addCommand({ id: 'notion-new-subpage', name: '在当前页面里新建子页面 / New sub-page', checkCallback: checking => {
			const f = this.app.workspace.getActiveFile(); if (!f || f.extension !== 'md') return false;
			if (!checking) void this.mode.newPage(this.model.nodeForFile(f), { link: true }); return true;
		} });
		// round 8: Notion block shortcuts (default keys are swapped in only while Notion mode is on, see mode.applyHotkeys)
		const blockCmd = (id: string, name: string, op: BlockOp) => this.addCommand({ id, name, editorCheckCallback: (checking, editor) => {
			if (!this.mode.on || !this.settings.blockHandles) return false;
			const cm = (editor as any).cm as EditorView | undefined;
			if (!cm) return false;
			if (!checking) runBlockOp(cm, op);
			return true;
		} });
		blockCmd('notion-block-duplicate', '块：创建副本 / Duplicate block', { op: 'duplicate' });
		blockCmd('notion-block-up', '块：上移 / Move block up', { op: 'move', dir: -1 });
		blockCmd('notion-block-down', '块：下移 / Move block down', { op: 'move', dir: 1 });
		for (const [n, to, zh] of TURN_KEYS) blockCmd(`notion-block-turn-${n}`, `块：转换为${zh} / Turn into (${n})`, { op: 'turn', to });
		this.addCommand({ id: 'notion-toggle-dark', name: '切换深色模式 / Toggle dark mode', callback: () => this.mode.toggleDark() });
		this.addCommand({ id: 'notion-open-tree', name: '显示页面侧边栏 / Show page sidebar', callback: () => void this.mode.ensureTree(true) });
		this.app.workspace.onLayoutReady(() => { this.compat.state = { ...probe(this.app, { plugin: this, MenuItem }), ...Object.fromEntries(Object.entries(this.compat.state).filter(([, v]) => v !== 'unknown')) }; });
		this.app.workspace.onLayoutReady(async () => { if (await this.notionModeWanted()) { await this.mode.enable(); this.refreshHeaders(); } });
	}

	/** Full-screen .base leaves of imported databases get the same `.notion` scope as imported pages
	 *  (fonts, gray Bases chrome, pills); other .base files are left alone. */
	markBaseLeaves() {
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			const v = leaf.view as unknown as { file?: TFile; containerEl: HTMLElement };
			const on = !!v.file && this.notionBases.has(v.file.path);
			v.containerEl.toggleClass('notion', on);
			v.containerEl.toggleClass('notion-base', on);
		}
	}

	/** A note Obsidian / Bases just created with its default name (see isDefaultNewName) inside a database folder
	 *  (or anywhere while Notion mode is on) is renamed to 「无标题」 / 「无标题 2」…, like the plugin's own new pages. */
	private renameChain: Promise<unknown> = Promise.resolve();
	private unloaded = false;   // pending rename timers do nothing after the plugin is disabled
	private renameDefaultNew(f: unknown) {
		if (!(f instanceof TFile) || f.extension !== 'md' || !isDefaultNewName(f.basename)) return;
		const inDb = !!f.parent?.children.some(c => c instanceof TFile && c.extension === 'base');
		if (!inDb && !this.mode.on) return;
		const name = f.basename, path0 = f.path;
		window.setTimeout(() => {   // let Bases finish (it writes the board group / filter values right after creating)
			if (this.unloaded || f.path !== path0 || f.basename !== name || !this.app.vault.getAbstractFileByPath(f.path)) return;   // already renamed by the user
			// one rename at a time: two new notes at once must not both pick 「无标题 3」
			this.renameChain = this.renameChain.then(async () => {
				if (f.basename !== name || !this.app.vault.getAbstractFileByPath(f.path)) return;
				await this.app.fileManager.renameFile(f, uniquePath(this.app, f.parent?.path ?? '', UNTITLED, 'md'));
			}).catch(() => null);
		}, 700);
	}

	onunload() {
		this.unloaded = true;
		this.mode?.unload();
		this.app.workspace.detachLeavesOfType('notion-page-tree');
		document.body.removeClass('notion-hide-meta');
		document.body.removeClass('notion-hide-system');
		this.app.workspace.getLeavesOfType('bases').forEach(l => l.view.containerEl.removeClass('notion', 'notion-base'));
		document.querySelectorAll('.notion-header').forEach(e => e.remove());
		this.icons?.clearAll();
	}

	async saveSettings() { await this.saveData(this.settings); }

	// ---------------- page header ----------------
	private resolveImage(v: unknown, from: string): string | null {
		if (!v) return null;
		const s = String(v);
		const m = s.match(/^\[\[([^|\]]+)/);
		if (!m) return /^https?:/.test(s) ? s : null;
		const f = this.app.metadataCache.getFirstLinkpathDest(m[1], from);
		return f ? this.app.vault.getResourcePath(f) : null;
	}

	refreshHeaders() {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			const file = view.file;
			const root = view.containerEl;
			this.paintProps(root);
			const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter ?? null : null;
			const iconRaw = fm?.['notion-icon'] ?? fm?.icon ?? fm?.['icon-image'];
			// Notion mode: every page gets a header (hover → "添加图标 / 添加封面"), not only pages with a cover/icon
			const editable = !!this.mode?.on && !!file && !file.path.split('/').some(isHiddenName);
			if (!this.settings.showHeader || !file || (!editable && (!fm || !(fm.cover || iconRaw)))) {
				root.querySelectorAll('.notion-header').forEach(e => e.remove());
				root.removeClass('notion-has-cover');
				continue;
			}
			const cover = fm?.cover;
			const sig = `${file.path}|${cover ?? ''}|${iconRaw ?? ''}|${editable ? 'e' : ''}|${fm?.['notion-cover-position'] ?? ''}|${emojiLoaded() ? 'img' : ''}`;
			const iconStr = iconRaw ? String(iconRaw) : null;
			const isImg = !!iconStr && (/^\[\[/.test(iconStr) || /^https?:/.test(iconStr));
			let header: ReturnType<typeof renderHeader> | null = null;
			const make = () => (header ??= renderHeader(this.resolveImage(cover, file.path), isImg ? null : iconStr, isImg ? this.resolveImage(iconStr, file.path) : null));
			// keep headers that are already right (re-creating them on every metadata event made the banner jump)
			const keep = new Set<Element>();
			const place = (parent: Element, before: Element | null) => {
				const prev = before?.classList.contains('notion-header') ? before : before ? before.previousElementSibling : parent.firstElementChild;
				if (prev?.classList.contains('notion-header') && (prev as HTMLElement).dataset.sig === sig) { keep.add(prev); return; }
				const frag = document.createDocumentFragment(); toDom(make(), frag);
				const el = frag.firstElementChild as HTMLElement; el.dataset.sig = sig; keep.add(el);
				// emoji icon as an image (Windows draws newer emoji as boxes)
				const ic = el.querySelector<HTMLElement>(':scope > .notion-icon');
				if (ic && !ic.querySelector('img') && iconStr && isEmoji(iconStr) && this.settings.emojiImages) { const im = emojiEl(iconStr.trim(), 'n-emoji'); if (im.tagName === 'IMG') { ic.empty(); ic.appendChild(im); ic.addClass('is-emoji'); } }
				if (editable) this.mode.decorateHeader(el, file, fm);
				parent.insertBefore(frag, before ?? parent.firstChild);
			};
			const anchors = root.querySelectorAll('.inline-title');
			if (anchors.length) anchors.forEach(t => t.parentElement && place(t.parentElement, t));
			else root.querySelectorAll('.cm-sizer, .markdown-preview-sizer').forEach(sz => place(sz, sz.firstElementChild));
			root.querySelectorAll('.notion-header').forEach(e => { if (!keep.has(e)) e.remove(); });
			root.toggleClass('notion-has-cover', !!cover);
			this.bleed(root);
			this.watchSize(root);
			// late layout (fonts, scrollbar appearing, first paint of a new leaf) does not always resize anything
			for (const ms of [120, 500, 1500, 3000]) window.setTimeout(() => this.bleed(root), ms);
		}
	}


	/** Color select / multi-select / status values in the Properties panel with their Notion option colors.
	 *  Obsidian ≥ 1.15 lower-cases `data-property-key`, so keys are matched case-insensitively. Status values get
	 *  Notion's dot (data-n-status); an option whose Notion colour is "default" is still a (gray) pill. */
	private paintProps(root: HTMLElement) {
		const colors: Record<string, Record<string, string>> = {};
		const add = (k: string, v: Record<string, string>) => { const l = k.toLowerCase(); colors[l] = { ...colors[l], ...v }; };
		for (const m of this.baseColors.values()) for (const [k, v] of Object.entries(m)) add(k, v);
		for (const [k, v] of Object.entries(this.settings.colors || {})) add(k, v);
		const status = new Set<string>();
		for (const s of this.baseStatus.values()) for (const k of s) status.add(k.toLowerCase());
		root.querySelectorAll<HTMLElement>('.metadata-property').forEach(p => {
			const key = (p.dataset.propertyKey || '').toLowerCase();
			const map = colors[key];
			if (!map) return;
			p.querySelectorAll<HTMLElement>('.multi-select-pill').forEach(pill => {
				const t = pill.querySelector('.multi-select-pill-content')?.textContent?.trim() || '';
				if (map[t]) pill.dataset.nColor = map[t]; else delete pill.dataset.nColor;
			});
			const lt = p.querySelector<HTMLElement>('.metadata-input-longtext');
			if (lt) {
				const c = map[(lt.textContent || '').trim()];
				if (c) { lt.dataset.nColor = c; if (status.has(key)) lt.dataset.nStatus = ''; else delete lt.dataset.nStatus; }
				else { delete lt.dataset.nColor; delete lt.dataset.nStatus; }
			}
		});
	}

	/** Re-measure the cover whenever the pane changes size (window resize, sidebar animation, split drag,
	 *  zoom). Workspace 'resize' alone missed some of these and left a strip on the right. */
	private watched = new WeakSet<HTMLElement>();
	private watchSize(root: HTMLElement) {
		if (this.watched.has(root)) return;
		this.watched.add(root);
		let raf = 0;
		const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.bleed(root)); });
		root.querySelectorAll('.view-content, .markdown-preview-view, .cm-scroller, .markdown-preview-sizer, .cm-sizer').forEach(e => ro.observe(e));
		this.register(() => ro.disconnect());
	}

	/** Make the cover span the whole pane like Notion (the header lives inside the readable-width column). */
	private bleed(root: HTMLElement) {
		root.querySelectorAll<HTMLElement>('.notion-header .notion-cover').forEach(cover => {
			const scroller = cover.closest('.markdown-preview-view, .cm-scroller') as HTMLElement | null;
			const col = cover.parentElement?.parentElement;
			if (!scroller || !col) return;
			const pane = (cover.closest('.view-content') as HTMLElement | null) || scroller;
			const s = scroller.getBoundingClientRect(); const c = col.getBoundingClientRect(); const v = pane.getBoundingClientRect();
			if (!v.width) return; // hidden leaf: measured again on the next layout-change
			cover.style.marginLeft = `${v.left - c.left}px`;
			cover.style.width = `${Math.min(v.width, scroller.clientWidth + (s.left - v.left) * 2)}px`;
			// rect-based offset can be measured mid-render (reading view, file switched in the same leaf) as 0;
			// the scroller's own top padding is a lower bound that is always right
			const top = Math.max(c.top - s.top + scroller.scrollTop, parseFloat(getComputedStyle(scroller).paddingTop) || 0);
			cover.style.marginTop = `${-Math.max(0, top)}px`;
		});
	}

	// ---------------- view blocks ----------------
	private rowsOf(folder: string): Row[] {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(folder));
		if (!(f instanceof TFolder)) return [];
		return f.children.filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
			.map(c => ({ name: c.basename, path: c.path, props: this.app.metadataCache.getFileCache(c)?.frontmatter || {} }));
	}

	private renderChart(src: string, el: HTMLElement) {
		try {
			const spec = parseSpec(src);
			toDom(renderChart(spec, this.rowsOf(spec.source)), el);
		} catch (e) { el.createEl('pre', { text: 'notion-chart: ' + (e as Error).message }); }
	}

	private renderCalendar(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		try {
			const spec = parseSpec(src);
			toDom(renderCalendar(spec, this.rowsOf(spec.source)), el);
			el.querySelectorAll<HTMLAnchorElement>('a.n-cal-item').forEach(a => a.addEventListener('click', ev => {
				ev.preventDefault(); this.app.workspace.openLinkText(a.dataset.href || '', ctx.sourcePath);
			}));
		} catch (e) { el.createEl('pre', { text: 'notion-calendar: ' + (e as Error).message }); }
	}

	private renderToc(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		const heads = f instanceof TFile ? this.app.metadataCache.getFileCache(f)?.headings || [] : [];
		const box = el.createDiv({ cls: 'n-toc' });
		for (const hd of heads) {
			const a = box.createEl('a', { text: hd.heading, cls: `n-toc-l${hd.level} internal-link` });
			a.addEventListener('click', ev => { ev.preventDefault(); this.app.workspace.openLinkText('#' + hd.heading, ctx.sourcePath); });
		}
	}

	// ---------------- import ----------------
	transport(): Transport {
		const token = this.settings.token.trim();
		return async (method, path, body) => {
			const r = await requestUrl({
				url: 'https://api.notion.com/v1' + path, method, throw: false,
				headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
				body: body ? JSON.stringify(body) : undefined,
			});
			let json: any = null; try { json = r.json; } catch { /* non-JSON error page */ }
			return { status: r.status, json, headers: r.headers };
		};
	}

	async ensureFolder(path: string) {
		const parts = normalizePath(path).split('/'); let cur = '';
		for (const p of parts) {
			if (!p) continue;
			cur = cur ? `${cur}/${p}` : p;
			if (!(await this.app.vault.adapter.exists(cur))) { try { await this.app.vault.createFolder(cur); } catch { /* race */ } }
		}
	}

	private parent = (p: string) => p.split('/').slice(0, -1).join('/');

	/** Vault I/O for the backup pipeline: notes through the Vault API (indexed, links follow renames),
	 *  raw JSON straight through the adapter. */
	vaultIO(): VaultIO {
		const vault = this.app.vault, ad = vault.adapter;
		return {
			read: async p => { p = normalizePath(p); return (await ad.exists(p)) ? ad.read(p) : null; },
			write: async (p, content) => {
				p = normalizePath(p);
				await this.ensureFolder(this.parent(p));
				if (/\.(md|base)$/.test(p)) {
					const f = vault.getAbstractFileByPath(p);
					if (f instanceof TFile) await vault.modify(f, content); else await vault.create(p, content);
				} else await ad.write(p, content);
			},
			writeBinary: async (p, data) => {
				p = normalizePath(p);
				await this.ensureFolder(this.parent(p));
				const f = vault.getAbstractFileByPath(p);
				if (f instanceof TFile) await vault.modifyBinary(f, data); else await vault.createBinary(p, data);
			},
			size: async p => { const st = await ad.stat(normalizePath(p)); return st ? st.size : -1; },
			rename: async (from, to) => {
				const f = vault.getAbstractFileByPath(normalizePath(from));
				await this.ensureFolder(this.parent(normalizePath(to)));
				if (f) await this.app.fileManager.renameFile(f, normalizePath(to)); else await ad.rename(normalizePath(from), normalizePath(to));
			},
			copy: async (from, to) => { await this.ensureFolder(this.parent(normalizePath(to))); await ad.copy(normalizePath(from), normalizePath(to)); },
			list: async folder => { folder = normalizePath(folder); return (await ad.exists(folder)) ? (await ad.list(folder)).files : []; },
			remove: async p => { p = normalizePath(p); if (await ad.exists(p)) await ad.remove(p); },
			// imported notes / bases the user moved or renamed: found through their notion id (metadata cache for
			// notes, the `notion:` block for .base files)
			notionIndex: async () => {
				const out: Record<string, string[]> = {};
				const add = (id: string, p: string) => { (out[id] ||= []).push(p); };
				for (const f of vault.getFiles()) {
					if (f.extension === 'md') {
						const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
						const id = fm?.['notion-id'];
						if (id) add(String(id).replace(/-/g, '').toLowerCase(), f.path);
						else if (fm?.['notion-holder'] === 'unclassified') add('holder:unclassified', f.path);
					} else if (f.extension === 'base') {
						const id = notionIdOf(f.path, await vault.cachedRead(f));
						if (id) add(id, f.path);
					}
				}
				return out;
			},
			removeEmptyDir: async p => {
				const f = vault.getAbstractFileByPath(normalizePath(p));
				if (!(f instanceof TFolder) || f.children.length) return false;
				await vault.delete(f); return true;
			},
		};
	}

	fetcher(): Fetcher {
		return async url => {
			const r = await requestUrl({ url, throw: false });
			return { status: r.status, data: r.arrayBuffer, contentType: r.headers?.['content-type'] ?? r.headers?.['Content-Type'] };
		};
	}

	backupSettings(): BackupSettings {
		const roots = this.settings.roots.split(/\n|,/).map(s => s.trim()).filter(Boolean).map(parseNotionId).filter((x): x is string => !!x);
		return { target: this.settings.targetFolder, roots, rowBodies: this.settings.rowBodies, comments: this.settings.comments, downloadExternal: this.settings.downloadExternal,
			coloredPills: this.settings.coloredPills, staticHeader: this.settings.staticHeader, templates: this.settings.templates, markdownCopy: this.settings.markdownCopy, timeZone: defaultTimeZone(), pluginVersion: this.manifest.version,
			ignore: this.settings.ignored.map(x => x.id), incremental: this.settings.incremental,
			resolveConflicts: c => askConflicts(this.app, c) };
	}

	async runImport(log: (s: string) => void, cancelled: () => boolean, offline = false, full = false) {
		if (this.settings.stopSync) throw new Error(STOP_MSG);
		if (!offline && !this.settings.token.trim()) throw new Error('请先在设置里填写 Notion integration token');
		const r = offline
			? await rebuildFromRaw(this.vaultIO(), this.fetcher(), this.backupSettings(), log)
			: await runBackup(this.vaultIO(), this.transport(), this.fetcher(), { ...this.backupSettings(), fullVerify: full }, log, cancelled);
		if (r.res) {
			this.settings.colors = { ...this.settings.colors, ...r.res.colors };
			this.settings.baseIcons = { ...this.settings.baseIcons, ...r.res.baseIcons };
			await this.saveSettings();
		}
		const bad = r.lines.filter(l => !l.ok).length;
		if (bad) new Notice(`Notion 导入：${bad} 处不一致或错误，请查看 ${r.reportPath}`, 15000);
		const f = this.app.vault.getAbstractFileByPath(normalizePath(r.reportPath));
		if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f);
	}
}

const STOP_MSG = '已在设置里选择「搬家完成，停止从 Notion 同步」：不会再从 Notion 读取或覆盖任何内容，库里的文件都保留在本地。需要再同步时，到插件设置里关掉这个开关。';

class ImportModal extends Modal {
	private cancelled = false;
	private plugin: NotionLookalikePlugin;
	private offline: boolean;
	private full: boolean;
	constructor(app: App, plugin: NotionLookalikePlugin, offline = false, full = false) { super(app); this.plugin = plugin; this.offline = offline; this.full = full; }
	onOpen() {
		this.titleEl.setText(this.offline ? '从原始备份重新生成笔记' : this.full ? '完整校验同步（重新读取全部内容）' : '从 Notion 备份 / 同步（保留样式）');
		if (this.plugin.settings.stopSync) { this.contentEl.createEl('p', { text: STOP_MSG }); return; }
		const status = this.contentEl.createDiv({ cls: 'n-import-status', text: '准备开始…' });
		const btns = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = btns.createEl('button', { text: '取消' });
		cancel.onclick = () => { this.cancelled = true; this.close(); };
		this.plugin.runImport(s => status.setText(s), () => this.cancelled, this.offline, this.full)
			.then(() => { if (!this.cancelled) { new Notice('Notion 导入完成'); cancel.setText('关闭'); } })
			.catch(e => { status.setText('出错：' + (e as Error).message); });
	}
	onClose() { this.contentEl.empty(); }
}

class NotionSettingTab extends PluginSettingTab {
	private plugin: NotionLookalikePlugin;
	/** 「兼容性」: which Obsidian internals were found (shown at the end of the settings) */
	private compatSection(c: HTMLElement) {
		window.setTimeout(() => {
			if (!c.isConnected) return;
			new Setting(c).setName('兼容性').setHeading();
			const rows = this.plugin.compat.rows();
			const bad = rows.filter(r => r.state === 'missing').length;
			c.createEl('p', { cls: 'setting-item-description n-compat-intro', text: bad ? `有 ${bad} 项功能用到的 Obsidian 内部接口在这个版本里找不到，这些功能已自动换成 Obsidian 原来的做法，其它功能不受影响。` : '本插件有些功能用到了 Obsidian 没有公开的内部接口。下面是在你这个 Obsidian 版本里的检测结果；如果以后 Obsidian 更新改了这些接口，对应功能会自动退回 Obsidian 原来的做法，不会影响其它功能和你的数据。' });
			if (this.plugin.mode.keyCollisions.length) new Setting(c).setName('⚠ 有块快捷键没有启用').setDesc('这些按键已被别的命令占用，为了不影响它们没有启用（可以在 设置 → 快捷键 里给「块：…」命令另设按键）：' + this.plugin.mode.keyCollisions.join('；'));
			for (const r of rows) {
				const st = new Setting(c).setName(`${r.state === 'ok' ? '✓' : r.state === 'missing' ? '⚠' : '·'} ${r.feature}`)
					.setDesc(r.state === 'ok' ? '正常' : r.state === 'missing' ? `不可用，已退回：${r.fallback}` : '还没检测到（打开对应的数据库或功能后再看）');
				st.settingEl.addClass('n-compat-row', 'is-' + r.state);
			}
		}, 0);
	}
	constructor(app: App, plugin: NotionLookalikePlugin) { super(app, plugin); this.plugin = plugin; }
	display() {
		const { containerEl: c } = this; c.empty();
		const s = this.plugin.settings;
		this.compatSection(c);
		new Setting(c).setName('Notion 模式').setHeading();
		new Setting(c).setName('Notion 模式（像 Notion 一样使用 Obsidian）').setDesc('打开后：左侧是 Notion 式页面树（文件夹和同名笔记合成一个页面），顶部显示页面路径，页面上方可以添加图标和封面，输入 “/” 弹出块菜单，Ctrl+P 搜索页面，Ctrl+N 新建页面，数据库里点一行在右侧打开。关闭后恢复 Obsidian 原来的界面。文件始终是普通 Markdown。导入过 Notion 的库默认打开。')
			.addToggle(t => t.setValue(this.plugin.mode.on).onChange(async v => { await this.plugin.setNotionMode(v); }));
		new Setting(c).setName('“/” 块菜单').setDesc('Notion 模式下，在行首或空格后输入 “/” 打开块菜单（标题、待办、折叠列表、标注、分栏、数据库…）')
			.addToggle(t => t.setValue(s.slashMenu).onChange(async v => { s.slashMenu = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('块手柄 ⋮⋮').setDesc('Notion 模式下，鼠标移到块左边出现 ＋ 和 ⋮⋮：拖动移动块（也可以拖到左侧页面树里的页面上），点击 ⋮⋮ 打开删除 / 复制 / 转换为 / 颜色 / 转为页面菜单')
			.addToggle(t => t.setValue(s.blockHandles).onChange(async v => { s.blockHandles = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('数据库行在侧边打开').setDesc('Notion 模式下，点击数据库（Bases）里的一行，在右侧分栏打开页面，不替换当前页面（像 Notion 的 “侧边预览”）')
			.addToggle(t => t.setValue(s.sidePeek).onChange(async v => { s.sidePeek = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('用图片显示 emoji').setDesc('用内置的 Twemoji 图片画 emoji（图标、标注、正文），Windows 上不会再显示成方框。关闭后用系统字体。Emoji 图片：Twemoji，© Twitter, Inc 及其他贡献者（jdecked/twemoji v17.0.3），按 CC-BY 4.0 授权（https://creativecommons.org/licenses/by/4.0/）；emoji 名称/关键词：emojibase-data（MIT），源自 Unicode CLDR。')
			.addToggle(t => t.setValue(s.emojiImages).onChange(async v => { s.emojiImages = v; await this.plugin.saveSettings(); this.plugin.icons.version++; this.app.workspace.updateOptions(); this.plugin.refreshHeaders(); }));
		const rp = normalizePath(`${s.targetFolder || 'Notion'}/_导入报告.md`);
		if (this.app.vault.getAbstractFileByPath(rp)) new Setting(c).setName('导入报告').setDesc('查看上次备份 / 同步的核对结果（Notion 和库里的页面、块、文件数量）')
			.addButton(b => b.setButtonText('打开导入报告').onClick(() => { const f = this.app.vault.getAbstractFileByPath(rp); if (f instanceof TFile) void this.app.workspace.getLeaf(true).openFile(f); }));
		new Setting(c).setName('Notion 同步').setHeading();
		new Setting(c).setName('搬家完成，停止从 Notion 同步').setDesc('打开后，「从 Notion 导入/同步」不再连接 Notion，也不会覆盖库里的任何文件；现在库里的页面、数据库和附件全部保留，以后只在 Obsidian 里编辑。原始备份（_raw）也保留。随时可以关掉再同步。')
			.addToggle(t => t.setValue(s.stopSync).onChange(async v => { s.stopSync = v; await this.plugin.saveSettings(); new Notice(v ? '已停止从 Notion 同步，库里的内容都保留在本地' : '已恢复从 Notion 同步'); this.display(); }));
		if (!s.stopSync) {
			new Setting(c).setName('快速同步').setDesc('只读取 Notion 里有变化的页面和数据库（按 Notion 的「最后编辑时间」判断，拿不准的一律完整读取）。每 5 次或超过 7 天会自动做一次完整校验。')
				.addToggle(t => t.setValue(s.incremental).onChange(async v => { s.incremental = v; await this.plugin.saveSettings(); }));
			new Setting(c).setName('完整校验同步').setDesc('这一次重新读取全部内容（页面、数据库结构、视图、所有行），用来确认库里和 Notion 完全一致。比快速同步慢很多。')
				.addButton(b => b.setButtonText('开始完整校验').onClick(() => new ImportModal(this.app, this.plugin, false, true).open()));
			new Setting(c).setName('同步时的冲突处理').setDesc('只在本地改过、Notion 没变的页面：保留你的本地版本。两边都改过的页面：同步前会弹窗让你逐个选择「保留本地」或「用 Notion 覆盖」，默认保留本地，Notion 版本另存到「_同步冲突」；被覆盖的本地版本备份在「_本地修改备份」。导入报告的「变更记录」列出所有被覆盖的文件和备份位置。');
		}
		new Setting(c).setName('Notion 备份').setHeading();
		if (s.ignored.length) {
			new Setting(c).setName('以后不再同步的页面 / 数据库').setDesc('同步时跳过这些（不覆盖、不移动、不删除库里已有的文件；原始 JSON 仍会备份到 _raw）。点「恢复」后下次同步会重新更新它们。');
			for (const it of [...s.ignored]) new Setting(c).setName(`${it.kind === 'database' ? '🗃️' : '📄'} ${it.title}`).setDesc(it.id)
				.addButton(b => b.setButtonText('恢复同步').onClick(async () => { s.ignored = s.ignored.filter(x => x.id !== it.id); await this.plugin.saveSettings(); this.display(); }));
		}
		new Setting(c).setName('Notion integration token').setDesc('ntn_… — 在 Notion「Connections」里新建 integration，并把要导入的页面共享给它。只做只读请求。保存在本插件的 data.json 中。')
			.addText(t => { t.inputEl.type = 'password'; t.setPlaceholder('ntn_...').setValue(s.token).onChange(async v => { s.token = v; await this.plugin.saveSettings(); }); });
		new Setting(c).setName('要导入的页面').setDesc('每行一个页面链接或 ID；留空 = 导入 integration 能看到的全部顶层页面')
			.addTextArea(t => t.setValue(s.roots).onChange(async v => { s.roots = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('目标文件夹').addText(t => t.setValue(s.targetFolder).onChange(async v => { s.targetFolder = v || 'Notion'; await this.plugin.saveSettings(); }));
		new Setting(c).setName('彩色标签').setDesc('在 Bases 里用 html() 公式把单选/多选/状态显示成 Notion 颜色的标签')
			.addToggle(t => t.setValue(s.coloredPills).onChange(async v => { s.coloredPills = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('导入数据库行的正文').addToggle(t => t.setValue(s.rowBodies).onChange(async v => { s.rowBodies = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('显示封面和图标').setDesc('在笔记标题上方画出 Notion 式封面横幅 + 图标（读取 cover / icon 属性）')
			.addToggle(t => t.setValue(s.showHeader).onChange(async v => { s.showHeader = v; await this.plugin.saveSettings(); this.plugin.refreshHeaders(); }));
		new Setting(c).setName('显示页面图标').setDesc('像 Notion 一样在文件列表、标签页标题、内部链接和 Bases 表格/卡片的名称前显示页面图标（读取 notion-icon 属性）')
			.addToggle(t => t.setValue(s.showIcons).onChange(async v => { s.showIcons = v; await this.plugin.saveSettings(); this.plugin.icons.enabled = v; this.plugin.icons.clearAll(); this.plugin.icons.version++; this.app.workspace.updateOptions(); this.plugin.icons.schedule(null, true); }));
		new Setting(c).setName('Notion 式视图标签').setDesc('在数据库（.base 文件和嵌入的 base 代码块）上方像 Notion 一样显示视图标签，代替 Bases 的下拉菜单。点当前标签可重命名/配置视图，“+”新建视图')
			.addToggle(t => t.setValue(s.viewTabs).onChange(async v => { s.viewTabs = v; await this.plugin.saveSettings(); this.plugin.tabs.enabled = v; this.plugin.tabs.refreshAll(); }));
		new Setting(c).setName('备份评论').setDesc('页面和块上的评论（需要 integration 打开 “Read comments” 权限）。“全部”会对每个块多发一个请求，导入更慢')
			.addDropdown(d => d.addOptions({ all: '全部（页面 + 每个块）', pages: '只备份页面评论', none: '不备份' }).setValue(s.comments).onChange(async v => { s.comments = v as Settings['comments']; await this.plugin.saveSettings(); }));
		new Setting(c).setName('同时下载外部文件').setDesc('图片/文件块里引用的外部链接也存一份到 _attachments/external（防止原网址失效）')
			.addToggle(t => t.setValue(s.downloadExternal).onChange(async v => { s.downloadExternal = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('隐藏 Notion 元数据属性').setDesc('属性面板里不显示 notion-id / notion-url / notion-created / notion-edited / notion-title（数据仍在笔记里）')
			.addToggle(t => t.setValue(s.hideMeta).onChange(async v => { s.hideMeta = v; await this.plugin.saveSettings(); document.body.toggleClass('notion-hide-meta', v); }));
		new Setting(c).setName('在文件列表中隐藏备份文件夹').setDesc('文件列表里不显示 _raw（原始 JSON 备份）和 _attachments（附件）文件夹，也不显示 .base 的 “BASE” 标记；文件仍在磁盘上')
			.addToggle(t => t.setValue(s.hideSystem).onChange(async v => { s.hideSystem = v; document.body.toggleClass('notion-hide-system', v); await this.plugin.saveSettings(); }));
		new Setting(c).setName('备份数据库模板').setDesc('每个数据库的 Notion 模板（只读 GET /data_sources/{id}/templates），存进 _raw 并在数据库文件夹的 Templates 子文件夹里生成笔记')
			.addToggle(t => t.setValue(s.templates).onChange(async v => { s.templates = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('同时备份 Notion 自己的 Markdown').setDesc('每个页面多一个只读请求（GET /pages/{id}/markdown），把 Notion 官方导出的 Markdown 存在 _raw/markdown/，作为块 JSON 之外的第二份原始备份')
			.addToggle(t => t.setValue(s.markdownCopy).onChange(async v => { s.markdownCopy = v; await this.plugin.saveSettings(); }));
		new Setting(c).setName('同时把封面写进正文').setDesc('不装本插件也能看到封面（会在正文开头多一行图片）')
			.addToggle(t => t.setValue(s.staticHeader).onChange(async v => { s.staticHeader = v; await this.plugin.saveSettings(); }));
	}
}
