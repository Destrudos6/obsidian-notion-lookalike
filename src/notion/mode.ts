/* eslint-disable @typescript-eslint/no-explicit-any */
// "Notion 模式": one switch that wraps Obsidian so it looks and works like Notion for one person.
// Everything is a layer over the stock UI: turning it off removes the classes, views, buttons and key
// handlers again, and the files stay plain Markdown + .base (no format of their own).
// Public APIs first; the few private internals are guarded and listed in NOTES.md (Round 6).
import { MarkdownView, Menu, Notice, TFile, TFolder, type WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import { setCssClass } from '../core/display.ts';
import type { NotionHost } from './host.ts';
import { PageTreeView, TREE_VIEW } from './tree.ts';
import { PageSearchModal } from './search.ts';
import { openCoverPicker, openIconPicker, randomCover, setFm } from './picker.ts';
import { emojiList, emojifyText } from '../emoji.ts';
import { createPage, movePage, subPageFolder, trashPage, type PageNode } from './pages.ts';

/** Notion's "turn into" keys (Ctrl+Shift+N on Windows, Ctrl+Alt+N on macOS); 9 = page is not mapped */
export const TURN_KEYS: [string, import('./block-model.ts').TurnInto, string][] = [
	['0', 'text', '文本'], ['1', 'h1', '标题 1'], ['2', 'h2', '标题 2'], ['3', 'h3', '标题 3'], ['4', 'todo', '待办'],
	['5', 'bullet', '项目符号列表'], ['6', 'numbered', '编号列表'], ['7', 'toggle', '折叠列表'], ['8', 'code', '代码'],
];

export class NotionMode {
	host: NotionHost;
	on = false;
	private cleanups: (() => void)[] = [];
	private peekLeaf: WorkspaceLeaf | null = null;
	private addedInlineTitle = false;
	private prevUpdateLinks: unknown = undefined;

	constructor(host: NotionHost) { this.host = host; }
	get app() { return this.host.app; }

	/** called once from onload: registers things that are inert while the mode is off */
	load() {
		const { plugin } = this.host;
		plugin.registerView(TREE_VIEW, leaf => new PageTreeView(leaf, this.host));
		const decorate = debounce(() => this.decorateLeaves(), 60, true);
		plugin.registerEvent(this.app.workspace.on('layout-change', decorate));
		plugin.registerEvent(this.app.workspace.on('file-open', f => { decorate(); if (this.on && f) this.afterOpen(f); }));
		plugin.registerEvent(this.app.vault.on('rename', (f, old) => { decorate(); if (this.on) void this.onRename(f, old); }));
		plugin.registerEvent(this.app.metadataCache.on('changed', () => { if (this.on) decorate(); }));
		// side peek for database rows
		plugin.registerDomEvent(document, 'click', ev => this.onClick(ev), { capture: true });
	}

	async enable() {
		if (this.on) return;
		this.on = true;
		document.body.addClass('notion-mode');
		if (!document.body.hasClass('show-inline-title')) { document.body.addClass('show-inline-title'); this.addedInlineTitle = true; }
		// Notion: links always follow a renamed / moved page → Obsidian's "Automatically update internal links"
		// (private config API; restored when the mode is turned off)
		try {
			const v: any = this.app.vault;
			const cur = v.getConfig?.('alwaysUpdateLinks');
			if (cur !== true && v.setConfig) { this.prevUpdateLinks = cur ?? false; v.setConfig('alwaysUpdateLinks', true); }
		} catch { /* private API missing: renames still work, links may need Obsidian's own prompt */ }
		this.app.workspace.onLayoutReady(async () => {
			if (!this.on) return;
			this.applyHotkeys(true);
			await this.ensureTree(true);
			this.decorateLeaves();
		});
	}

	async disable() {
		if (!this.on) return;
		this.on = false;
		document.body.removeClass('notion-mode');
		if (this.addedInlineTitle) { document.body.removeClass('show-inline-title'); this.addedInlineTitle = false; }
		if (this.prevUpdateLinks !== undefined) { try { (this.app.vault as any).setConfig('alwaysUpdateLinks', this.prevUpdateLinks); } catch { /* */ } this.prevUpdateLinks = undefined; }
		this.applyHotkeys(false);
		this.app.workspace.detachLeavesOfType(TREE_VIEW);
		const fe = this.app.workspace.getLeavesOfType('file-explorer')[0];
		if (fe) void this.app.workspace.revealLeaf(fe);
		this.undecorate();
		this.peekLeaf = null;
	}

	unload() {
		this.applyHotkeys(false);
		if (this.prevUpdateLinks !== undefined) { try { (this.app.vault as any).setConfig('alwaysUpdateLinks', this.prevUpdateLinks); } catch { /* */ } }
		this.undecorate(); document.body.removeClass('notion-mode'); if (this.addedInlineTitle) document.body.removeClass('show-inline-title'); }

	async ensureTree(reveal: boolean) {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(TREE_VIEW)[0];
		if (!leaf) {
			leaf = ws.getLeftLeaf(false) ?? ws.getLeftLeaf(true)!;
			await leaf.setViewState({ type: TREE_VIEW, active: true });
		}
		if (reveal) { await ws.revealLeaf(leaf); (ws as any).leftSplit?.expand?.(); }
		return leaf;
	}

	tree(): PageTreeView | null {
		const l = this.app.workspace.getLeavesOfType(TREE_VIEW)[0];
		return l && l.view instanceof PageTreeView ? l.view : null;
	}

	// ---------------------------------------------------------------- leaves: scope class, edit mode, breadcrumb
	private decorateLeaves() {
		if (!this.on) return;
		this.app.workspace.iterateAllLeaves(leaf => {
			const v: any = leaf.view;
			const type = v?.getViewType?.();
			if (type !== 'markdown' && type !== 'bases') return;
			v.containerEl.addClass('notion', 'n-mode-leaf');
			if (type === 'markdown' && v.getMode?.() === 'preview') {
				const st = leaf.getViewState();
				void leaf.setViewState({ ...st, state: { ...st.state, mode: 'source', source: false } });
			}
			this.breadcrumb(leaf);
			if (type === 'markdown') this.pageMoreButton(leaf);
			// edit mode only: hide the reading/editing switch (found by its icon; its label is localised)
			v.containerEl.querySelectorAll(':scope > .view-header .view-action').forEach((a: HTMLElement) => {
				if (a.querySelector('svg.lucide-book-open, svg.lucide-pencil, svg.lucide-edit-3, svg.lucide-pen-line')) a.dataset.nHide = '';
			});
		});
	}

	private undecorate() {
		document.querySelectorAll('.n-crumbs, .n-page-more, .n-locked-badge').forEach(e => e.remove());
		document.querySelectorAll('.n-locked').forEach(e => e.removeClass('n-locked'));
		document.querySelectorAll('.n-mode-leaf').forEach(e => {
			e.removeClass('n-mode-leaf');
			// imported notes keep `.notion` through their cssclasses; the leaf class came from us
			if (!e.hasClass('notion-base')) e.removeClass('notion');
		});
		document.querySelectorAll('.n-peek').forEach(e => e.removeClass('n-peek'));
		document.querySelectorAll<HTMLElement>('[data-n-hide]').forEach(e => delete e.dataset.nHide);
		document.querySelectorAll('.n-peek-close').forEach(e => e.remove());
	}

	private breadcrumb(leaf: WorkspaceLeaf) {
		const v: any = leaf.view;
		const file: TFile | undefined = v.file;
		const header: HTMLElement | null = v.containerEl.querySelector(':scope > .view-header');
		const title = header?.querySelector<HTMLElement>('.view-header-title-container');
		if (!header || !title) return;
		let bc = header.querySelector<HTMLElement>(':scope > .n-crumbs');
		if (!file) { bc?.remove(); return; }
		const chain: PageNode[] = [...this.host.model.ancestors(file)];
		const me = this.host.model.nodeForFile(file);
		if (me) chain.push(me);
		const sig = chain.map(n => n.key + ':' + (n.file ? this.host.icons.iconFor(n.file.path) ?? '' : '')).join('|');
		if (bc && bc.dataset.sig === sig) return;
		if (!bc) { bc = createDiv({ cls: 'n-crumbs' }); title.before(bc); }
		bc.empty(); bc.dataset.sig = sig;
		// long paths collapse the middle like Notion: first … last two
		const shown = chain.length > 4 ? [chain[0], null, ...chain.slice(-2)] : chain;
		shown.forEach((n, i) => {
			if (i) bc!.createSpan({ cls: 'n-crumb-sep', text: '/' });
			if (!n) { bc!.createSpan({ cls: 'n-crumb is-more', text: '…' }); return; }
			const c = bc!.createDiv({ cls: 'n-crumb' + (i === shown.length - 1 ? ' is-current' : '') });
			const ic = n.file ? this.host.icons.iconFor(n.file.path) : undefined;
			if (ic) c.appendChild(this.host.icons.makeIcon(ic, n.file!.path, 'is-crumb'));
			c.createSpan({ cls: 'n-crumb-title', text: n.title });
			c.onclick = () => { if (n.file) void this.host.openFile(n.file); else this.tree()?.render(); };
		});
		emojifyText(bc);
	}

	// ---------------------------------------------------------------- page "···" menu (top right, like Notion)
	classesOf(file: TFile): string[] {
		const c = this.app.metadataCache.getFileCache(file)?.frontmatter?.cssclasses;
		return (Array.isArray(c) ? c : c ? [c] : []).map(String);
	}
	isLocked(file: TFile | null | undefined): boolean { return !!file && this.classesOf(file).includes('notion-locked'); }

	private pageMoreButton(leaf: WorkspaceLeaf) {
		const v = leaf.view as MarkdownView;
		const actions = v.containerEl.querySelector<HTMLElement>(':scope > .view-header .view-actions');
		if (!actions) return;
		// Obsidian's own ⋮ menu: its items are appended to ours (onPaneMenu, public API) → hide the button
		actions.querySelectorAll<HTMLElement>('.view-action').forEach(a => { if (a.querySelector('svg.lucide-more-vertical') && !a.hasClass('n-page-more')) a.dataset.nHide = ''; });
		if (!actions.querySelector('.n-page-more')) {
			const b = createEl('a', { cls: 'clickable-icon view-action n-page-more', attr: { 'aria-label': '页面选项（字体、全宽、锁定…）' } });
			setIcon(b, 'more-horizontal');
			b.onclick = ev => this.pageMenu(v, ev);
			actions.appendChild(b);
		}
		// lock badge in the header (Notion shows "已锁定" at the top of a locked page)
		const header = v.containerEl.querySelector<HTMLElement>(':scope > .view-header');
		const locked = this.isLocked(v.file);
		v.containerEl.toggleClass('n-locked', locked);
		let badge = header?.querySelector<HTMLElement>('.n-locked-badge') ?? null;
		if (locked && header && !badge) {
			badge = createDiv({ cls: 'n-locked-badge', attr: { 'aria-label': '页面已锁定，点击解锁' } });
			setIcon(badge.createSpan(), 'lock'); badge.createSpan({ text: '已锁定' });
			badge.onclick = () => { if (v.file) void this.setClass(v.file, 'notion-locked', false); };
			actions.before(badge);
		} else if (!locked) badge?.remove();
	}

	async setClass(file: TFile, cls: string, on: boolean) {
		await this.app.vault.process(file, t => setCssClass(t, cls, on));
		window.setTimeout(() => this.decorateLeaves(), 200);
	}

	pageMenu(v: MarkdownView, ev: MouseEvent) {
		const file = v.file; if (!file) return;
		const cls = this.classesOf(file);
		const m = new Menu();
		const font = cls.includes('notion-font-serif') ? 'serif' : cls.includes('notion-font-mono') ? 'mono' : 'default';
		const setFont = async (f: string) => {
			await this.app.vault.process(file, t => setCssClass(setCssClass(t, 'notion-font-serif', f === 'serif'), 'notion-font-mono', f === 'mono'));
		};
		m.addItem(i => i.setTitle('字体：默认').setIcon('type').setChecked(font === 'default').onClick(() => void setFont('default')));
		m.addItem(i => i.setTitle('字体：衬线').setIcon('type').setChecked(font === 'serif').onClick(() => void setFont('serif')));
		m.addItem(i => i.setTitle('字体：等宽').setIcon('type').setChecked(font === 'mono').onClick(() => void setFont('mono')));
		m.addSeparator();
		const tog = (title: string, icon: string, c: string) => m.addItem(i => i.setTitle(title).setIcon(icon).setChecked(cls.includes(c)).onClick(() => void this.setClass(file, c, !cls.includes(c))));
		tog('小字号', 'a-large-small', 'notion-small-text');
		tog('全宽', 'move-horizontal', 'notion-full-width');
		tog('锁定页面', 'lock', 'notion-locked');
		m.addSeparator();
		m.addItem(i => i.setTitle('复制链接').setIcon('link').onClick(async () => {
			await navigator.clipboard.writeText(this.app.fileManager.generateMarkdownLink(file, ''));
			new Notice('已复制页面链接');
		}));
		const nurl = this.app.metadataCache.getFileCache(file)?.frontmatter?.['notion-url'];
		if (nurl) m.addItem(i => i.setTitle('复制 Notion 链接').setIcon('external-link').onClick(async () => { await navigator.clipboard.writeText(String(nurl)); new Notice('已复制 Notion 链接'); }));
		m.addItem(i => i.setTitle('移动到…').setIcon('corner-up-right').onClick(() => {
			const node = this.host.model.nodeForFile(file);
			if (node) this.pickPage('移动到…', async target => {
				const dest = target ? await subPageFolder(this.app, this.host.model, target, this.host.topFolder()) : this.host.topFolder();
				if (await movePage(this.app, node, dest)) new Notice(`已移动到“${target?.title ?? '顶层'}”`);
			}, node);
		}));
		m.addItem(i => i.setTitle('删除').setIcon('trash-2').setWarning(true).onClick(async () => {
			const node = this.host.model.nodeForFile(file);
			if (!node) return;
			const c = new Menu();
			c.addItem(x => x.setTitle(`把“${node.title}”${node.folder ? '和它的子页面' : ''}移到回收站？`).setDisabled(true));
			c.addItem(x => x.setTitle('移到回收站').setIcon('trash-2').setWarning(true).onClick(async () => { await trashPage(this.app, node); new Notice(`已把“${node.title}”移到回收站`); }));
			c.addItem(x => x.setTitle('取消').setIcon('x'));
			c.showAtMouseEvent(ev);
		}));
		// Obsidian's own pane menu (split, reading view, history if the core plugin is on, …) at the end
		m.addSeparator();
		m.addItem(i => {
			i.setTitle('Obsidian 选项').setIcon('more-vertical');
			const sub = (i as any).setSubmenu?.();   // private: submenu; else a second menu
			const fill = (mm: Menu) => { try { (v as any).onPaneMenu?.(mm, 'more-options'); } catch { /* */ } };
			if (sub) fill(sub); else i.onClick(() => { const mm = new Menu(); fill(mm); mm.showAtMouseEvent(ev); });
		});
		m.showAtMouseEvent(ev);
	}

	// ---------------------------------------------------------------- page header controls (icon / cover)
	/** Called by the plugin after it (re)drew a `.notion-header` in a markdown view. */
	decorateHeader(header: HTMLElement, file: TFile, fm: Record<string, any> | null) {
		if (!this.on) return;
		header.addClass('n-editable');
		const hasIcon = !!(fm?.['notion-icon'] ?? fm?.icon ?? fm?.['icon-image']);
		const hasCover = !!fm?.cover;
		const icon = header.querySelector<HTMLElement>(':scope > .notion-icon');
		if (icon) { icon.addClass('is-clickable'); icon.onclick = () => openIconPicker(this.host, icon, file); icon.setAttr('aria-label', '更换图标'); }
		const cover = header.querySelector<HTMLElement>(':scope > .notion-cover');
		if (cover) {
			const pos = Number(fm?.['notion-cover-position']);
			if (Number.isFinite(pos)) cover.style.backgroundPosition = `center ${Math.max(0, Math.min(100, pos))}%`;
			const bar = cover.createDiv({ cls: 'n-cover-actions' });
			const b1 = bar.createDiv({ cls: 'n-cover-btn', text: '更换封面' });
			b1.onclick = ev => { ev.stopPropagation(); openCoverPicker(this.host, b1, file); };
			const b2 = bar.createDiv({ cls: 'n-cover-btn', text: '调整位置' });
			b2.onclick = ev => { ev.stopPropagation(); this.reposition(cover, file, Number.isFinite(pos) ? pos : 50); };
		}
		const ctl = createDiv({ cls: 'n-header-controls' });
		if (!hasIcon) {
			const b = ctl.createDiv({ cls: 'n-header-btn' });
			setIcon(b.createSpan(), 'smile'); b.createSpan({ text: '添加图标' });
			b.onclick = async () => {
				// Notion adds a random emoji right away and opens the picker on it
				const l = emojiList().filter(e => e[1] < 9 && e[1] !== 2);
				const pick = l.length ? l[Math.floor(Math.random() * l.length)][0] : '📄';
				await setFm(this.app, file, 'notion-icon', pick);
			};
		}
		if (!hasCover) {
			const b = ctl.createDiv({ cls: 'n-header-btn' });
			setIcon(b.createSpan(), 'image'); b.createSpan({ text: '添加封面' });
			b.onclick = async () => setFm(this.app, file, 'cover', await randomCover(this.app, file));
		}
		if (ctl.childElementCount) {
			const after = icon ?? cover;
			if (after) after.after(ctl); else header.prepend(ctl);
		}
	}

	private reposition(cover: HTMLElement, file: TFile, start: number) {
		cover.addClass('is-repositioning');
		let y = start;
		const hint = cover.createDiv({ cls: 'n-cover-hint', text: '拖动图片调整位置' });
		const bar = cover.createDiv({ cls: 'n-cover-actions is-visible' });
		const save = bar.createDiv({ cls: 'n-cover-btn', text: '保存位置' });
		const cancel = bar.createDiv({ cls: 'n-cover-btn', text: '取消' });
		const end = () => { cover.removeClass('is-repositioning'); hint.remove(); bar.remove(); cover.onmousedown = null; };
		cover.onmousedown = (ev: MouseEvent) => {
			if ((ev.target as HTMLElement).closest('.n-cover-actions')) return;
			ev.preventDefault();
			const y0 = ev.clientY, s0 = y, h = cover.getBoundingClientRect().height || 200;
			const move = (e: MouseEvent) => { y = Math.max(0, Math.min(100, s0 - ((e.clientY - y0) / h) * 100)); cover.style.backgroundPosition = `center ${y}%`; };
			const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
			window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
		};
		save.onclick = async ev => { ev.stopPropagation(); end(); await setFm(this.app, file, 'notion-cover-position', String(Math.round(y))); };
		cancel.onclick = ev => { ev.stopPropagation(); end(); cover.style.backgroundPosition = `center ${start}%`; };
	}

	// ---------------------------------------------------------------- new pages / opening
	private justCreated = new Set<string>();

	async newPage(parent: PageNode | null, opts: { newTab?: boolean; link?: boolean } = {}): Promise<TFile | null> {
		try {
			const file = await createPage(this.app, this.host.model, parent, this.host.topFolder(), { linkFromParent: !!opts.link });
			this.justCreated.add(file.path);
			await this.host.openFile(file, !!opts.newTab);
			this.tree()?.reveal(file);
			return file;
		} catch (e) { new Notice('新建页面失败：' + (e as Error).message); return null; }
	}

	/** a page created by "+" opens with its title selected, ready to type (Notion) */
	private afterOpen(file: TFile) {
		this.tree()?.reveal(file);
		if (!this.justCreated.delete(file.path)) {
			// Notion opens a page without a caret; in Live Preview a caret on the first line shows that block's
			// Markdown source (e.g. a callout) – so take the focus away until the user clicks into the text
			window.setTimeout(() => {
				const v = this.app.workspace.getActiveViewOfType(MarkdownView);
				const a = document.activeElement as HTMLElement | null;
				if (v && v.file === file && a && v.containerEl.contains(a) && a.closest('.cm-content')) a.blur();
			}, 80);
			return;
		}
		const tryFocus = (n: number) => {
			const v = this.app.workspace.getActiveViewOfType(MarkdownView);
			const t = v?.containerEl.querySelector<HTMLElement>('.inline-title');
			if (!t) { if (n < 10) window.setTimeout(() => tryFocus(n + 1), 60); return; }
			t.focus();
			const r = document.createRange(); r.selectNodeContents(t);
			const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
		};
		window.setTimeout(() => tryFocus(0), 30);
	}

	// ---------------------------------------------------------------- rename / move bookkeeping
	private async onRename(f: TFile | TFolder | any, old: string) {
		if (f instanceof TFile && f.extension === 'md') {
			const oldDir = old.includes('/') ? old.slice(0, old.lastIndexOf('/')) : '';
			const oldBase = old.slice(old.lastIndexOf('/') + 1).replace(/\.md$/, '');
			const newDir = f.parent && f.parent.path !== '/' ? f.parent.path : '';
			if (oldDir === newDir && oldBase !== f.basename) {
				// title = file name: the sub-page folder follows the page (folder-note structure)
				const pre = newDir ? newDir + '/' : '';
				const folder = this.app.vault.getAbstractFileByPath(pre + oldBase);
				// after the current rename has finished (a rename started inside another rename's event can wait on it)
				if (folder instanceof TFolder && !this.app.vault.getAbstractFileByPath(pre + f.basename))
					window.setTimeout(() => { if (folder.parent && !this.app.vault.getAbstractFileByPath(pre + f.basename)) void this.app.fileManager.renameFile(folder, pre + f.basename); }, 60);
				// links written as [[path|Old title]] (the importer's child-page links) show the new title
				window.setTimeout(() => void this.fixAliases(f, oldBase), 700);
			}
		}
		if (f instanceof TFolder) await this.fixBasePaths(old, f.path);
	}

	private async fixAliases(file: TFile, oldTitle: string) {
		const rl = this.app.metadataCache.resolvedLinks;
		const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`\\[\\[([^\\]|\\n]+)\\|${esc}\\]\\]`, 'g');
		for (const [src, targets] of Object.entries(rl)) {
			if (!targets[file.path]) continue;
			const s = this.app.vault.getAbstractFileByPath(src);
			if (!(s instanceof TFile) || s.extension !== 'md') continue;
			await this.app.vault.process(s, t => t.replace(re, (all, link: string) => {
				const dest = this.app.metadataCache.getFirstLinkpathDest(link.replace(/[#^].*$/, ''), src);
				return dest === file ? `[[${link}|${file.basename}]]` : all;
			}));
		}
	}

	/** Database filters point at their folder (`file.folder == "X/Y"`): keep them right when a folder moves. */
	private async fixBasePaths(oldPath: string, newPath: string) {
		const esc = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`(\\\\?")${esc}(?=\\\\?"|/)`, 'g');
		let n = 0;
		for (const f of this.app.vault.getFiles()) {
			if (f.extension !== 'base' && f.extension !== 'md') continue;
			const text = await this.app.vault.cachedRead(f);
			if (!text.includes(oldPath)) continue;
			if (f.extension === 'base') {
				if (!re.test(text)) continue;
				re.lastIndex = 0;
				await this.app.vault.process(f, t => t.replace(re, `$1${newPath}`)); n++;
			} else {
				// only inside ```base code blocks
				let inBase = false, changed = false;
				const out = text.split('\n').map(l => {
					if (/^\s*(```|~~~)\s*base\s*$/.test(l)) { inBase = true; return l; }
					if (inBase && /^\s*(```|~~~)\s*$/.test(l)) { inBase = false; return l; }
					if (!inBase) return l;
					const r = l.replace(re, `$1${newPath}`); if (r !== l) changed = true; return r;
				}).join('\n');
				if (changed) { await this.app.vault.process(f, t => (t === text ? out : t)); n++; }
			}
		}
		if (n) new Notice(`已更新 ${n} 个数据库视图里的文件夹路径`);
	}

	// ---------------------------------------------------------------- keys
	/** Notion shortcuts: Ctrl+P = search pages, Ctrl+N = new page, Ctrl+Shift+L = dark mode. Obsidian handles hotkeys
	 *  before any DOM listener a plugin can add, so the DEFAULT hotkeys are swapped in memory through the hotkey
	 *  manager (private API, guarded; nothing is written to hotkeys.json; the user's own custom hotkeys still win).
	 *  The command palette moves to Ctrl+Shift+P. Turned back when the mode is switched off. */
	private savedKeys: [string, any[]][] | null = null;
	/** block shortcuts not assigned because another command already uses the key (shown in the 兼容性 section) */
	keyCollisions: string[] = [];
	private applyHotkeys(on: boolean) {
		try {
			const hm: any = (this.app as any).hotkeyManager;
			if (!hm?.getDefaultHotkeys || !hm.addDefaultHotkeys || !hm.removeDefaultHotkeys) { this.host.compat?.mark('hotkeys', false); return; }
			const id = this.host.plugin.manifest.id;
			const blockKeys: [string, any[]][] = [
				[`${id}:notion-block-duplicate`, [{ modifiers: ['Mod'], key: 'D' }]],
				[`${id}:notion-block-up`, [{ modifiers: ['Mod', 'Shift'], key: 'ArrowUp' }]],
				[`${id}:notion-block-down`, [{ modifiers: ['Mod', 'Shift'], key: 'ArrowDown' }]],
				...TURN_KEYS.map(([n]): [string, any[]] => [`${id}:notion-block-turn-${n}`, [{ modifiers: ['Mod', 'Shift'], key: n }, { modifiers: ['Mod', 'Alt'], key: n }]]),
			];
			// never take a key another command already has (default or the user's own); skipped ones are listed.
			// One deliberate exception, like Ctrl+P above: Notion's Ctrl+D (duplicate) replaces Obsidian's default
			// Ctrl+D = "delete paragraph" while Notion mode is on (that command stays in the palette, restored on off)
			const TAKE_OVER = new Set(['editor:delete-paragraph']);
			const sig = (k: any) => [...(k.modifiers || [])].map(String).sort().join('+') + '+' + String(k.key).toUpperCase();
			const used = new Set<string>();
			if (on && !this.savedKeys) {
				const cmds = Object.keys((this.app as any).commands?.commands ?? {});
				for (const c of cmds) { if (c.startsWith(id + ':') || TAKE_OVER.has(c)) continue; for (const k of [...(hm.getDefaultHotkeys(c) ?? []), ...(hm.getHotkeys?.(c) ?? [])]) used.add(sig(k)); }
			}
			this.keyCollisions = [];
			const blockSwap: [string, any[] | null][] = blockKeys.map(([cmd, keys]) => {
				const free = keys.filter(k => !used.has(sig(k)));
				if (free.length < keys.length) this.keyCollisions.push(`${cmd.split(':')[1]}: ${keys.filter(k => used.has(sig(k))).map(sig).join(', ')}`);
				return [cmd, free.length ? free : null];
			});
			const swap: [string, any[] | null][] = [
				...blockSwap,
				...(blockSwap[0][1] ? [['editor:delete-paragraph', null] as [string, null]] : []),
				['command-palette:open', [{ modifiers: ['Mod', 'Shift'], key: 'P' }]],
				['file-explorer:new-file', null],
				[`${id}:notion-search`, [{ modifiers: ['Mod'], key: 'P' }]],
				[`${id}:notion-new-page`, [{ modifiers: ['Mod'], key: 'N' }]],
				[`${id}:notion-toggle-dark`, [{ modifiers: ['Mod', 'Shift'], key: 'L' }]],
			];
			if (on && !this.savedKeys) {
				this.savedKeys = swap.map(([cmd]) => [cmd, (hm.getDefaultHotkeys(cmd) ?? []).map((k: any) => ({ ...k }))]);
				for (const [cmd, keys] of swap) { hm.removeDefaultHotkeys(cmd); if (keys) hm.addDefaultHotkeys(cmd, keys); }
			} else if (!on && this.savedKeys) {
				for (const [cmd, keys] of this.savedKeys) { hm.removeDefaultHotkeys(cmd); if (keys.length) hm.addDefaultHotkeys(cmd, keys); }
				this.savedKeys = null;
			}
			hm.bake?.();
		} catch (e) { console.warn('notion-lookalike: hotkeys unchanged', e); }
	}

	toggleDark() {
		const dark = document.body.hasClass('theme-dark');
		try { (this.app as any).changeTheme?.(dark ? 'moonstone' : 'obsidian') ?? (this.app as any).setTheme?.(dark ? 'moonstone' : 'obsidian'); }
		catch { /* private API missing */ }
		if (document.body.hasClass('theme-dark') === dark) { document.body.toggleClass('theme-dark', !dark); document.body.toggleClass('theme-light', dark); }
	}

	// ---------------------------------------------------------------- side peek
	private onClick(ev: MouseEvent) {
		if (!this.on || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
		const t = ev.target as HTMLElement | null;
		if (!t || !t.closest) return;
		// a row in a database view: the name link in a table, or a card / list item
		const base = t.closest('.bases-view, .bases-embed, .block-language-base, .workspace-leaf-content[data-type="bases"]');
		if (!base) return;
		const link = t.closest<HTMLElement>('a.internal-link, .internal-link');
		let target: TFile | null = null;
		if (link) {
			const href = link.dataset.href || link.getAttribute('href') || '';
			const leafEl = t.closest('.workspace-leaf');
			let src = '';
			this.app.workspace.iterateAllLeaves(l => { if (!src && (l as any).containerEl === leafEl) src = (l.view as any)?.file?.path ?? ''; });
			target = this.app.metadataCache.getFirstLinkpathDest(href.replace(/[#^].*$/, ''), src);
		}
		// board (kanban) / gallery (cards) card: Obsidian 1.15 does nothing on a click outside the title link of a
		// kanban card → open the card's note in the side peek like Notion. Private API: the Bases view keeps
		// columns[].items[] = { el, entry: { file } } (kanban) — fallback: the card title = file name.
		const card = !link ? t.closest<HTMLElement>('.bases-kanban-card, .bases-cards-item') : null;
		const busy = card ? t.closest('input, textarea, [contenteditable="true"], button, a, .metadata-property-value') : null;
		if (card && !(busy && card.contains(busy))) {   // (an embed sits inside the editor's contenteditable)
			target = this.cardFile(card, base);
		}
		if (!target || target.extension !== 'md') return;
		ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
		void this.peek(target, t.closest('.workspace-leaf'));
	}

	private cardFile(card: HTMLElement, base: Element): TFile | null {
		try {
			const leafEl = card.closest('.workspace-leaf');
			let view: any = null;
			this.app.workspace.iterateAllLeaves(l => { if (!view && (l as any).containerEl === leafEl) view = (l.view as any)?.controller?.view; });
			const cols: any[] = Array.isArray(view?.columns) ? view.columns : [];
			if (view) this.host.compat?.mark('boardItems', cols.length > 0 || Array.isArray(view?.items));
			for (const c of cols) for (const it of (c?.items ?? [])) if (it?.el === card && it.entry?.file instanceof TFile) return it.entry.file;
			const items: any[] = Array.isArray(view?.items) ? view.items : [];
			for (const it of items) if (it?.el === card && it.entry?.file instanceof TFile) return it.entry.file;
		} catch { /* private API changed → fallback below */ }
		const tEl = card.querySelector('.mod-title .bases-rendered-value, .mod-title [class*="-line"]');
		const title = (tEl?.querySelector('.internal-link') as HTMLElement | null)?.dataset.href || tEl?.textContent?.trim();
		if (!title) return null;
		let src = '';
		const leafEl = base.closest('.workspace-leaf');
		this.app.workspace.iterateAllLeaves(l => { if (!src && (l as any).containerEl === leafEl) src = (l.view as any)?.file?.path ?? ''; });
		return this.app.metadataCache.getFirstLinkpathDest(title, src);
	}

	async peek(file: TFile, fromLeafEl: Element | null) {
		const ws = this.app.workspace;
		let leaf = this.peekLeaf;
		let alive = false;
		if (leaf) ws.iterateRootLeaves(l => { if (l === leaf) alive = true; });   // only a peek in the main area counts
		if (!leaf || !alive) {
			// split next to the database the row came from (explicitly: getLeaf('split') splits whatever leaf is
			// active, which can be the page tree in the sidebar → the peek ended up hidden there)
			let from: WorkspaceLeaf | null = null;
			ws.iterateRootLeaves(l => { if (!from && (l as any).containerEl === fromLeafEl) from = l; });
			if (!from) { const a = ws.getMostRecentLeaf(ws.rootSplit); if (a) from = a; }
			leaf = from ? ws.createLeafBySplit(from, 'vertical') : ws.getLeaf('split', 'vertical');
			this.peekLeaf = leaf;
		}
		await leaf.openFile(file, { active: true });
		const el = (leaf as any).containerEl as HTMLElement | undefined;
		el?.addClass('n-peek');
		const header = leaf.view.containerEl.querySelector<HTMLElement>(':scope > .view-header');
		if (header && !header.querySelector('.n-peek-close')) {
			const b = createDiv({ cls: 'n-peek-close clickable-icon', attr: { 'aria-label': '关闭侧边预览' } });
			setIcon(b, 'chevrons-right');
			b.onclick = () => { leaf!.detach(); this.peekLeaf = null; };
			header.prepend(b);
		}
	}

	openSearch() { new PageSearchModal(this.app, this.host).open(); }
	pickPage(title: string, cb: (n: PageNode | null) => void, exclude: PageNode | null) {
		new PageSearchModal(this.app, this.host, { title, onPick: n => cb(n), exclude, allowTop: true }).open();
	}
}
