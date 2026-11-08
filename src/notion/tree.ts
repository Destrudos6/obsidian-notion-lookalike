/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion-style page tree for the left sidebar (Notion mode). Pages and sub-pages only: a note and the folder
// with its name are ONE row (folder note), databases are rows, bookkeeping folders are hidden.
// Hover: ··· (rename / duplicate / move / delete / copy link / open in new tab) and ＋ (add sub-page).
// Drag a row: above/below another row = reorder (stored in plugin data), onto a row = make it a sub-page.
import { ItemView, Menu, Notice, TFile, TFolder, type WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import type { NotionHost } from './host.ts';
import { duplicatePage, movePage, renamePage, subPageFolder, trashPage, type PageNode } from './pages.ts';
import { emojifyText, onEmojiReady } from '../emoji.ts';
import { rowFileFromElement } from './row-drag.ts';

export const TREE_VIEW = 'notion-page-tree';

type Zone = 'before' | 'after' | 'inside';

export class PageTreeView extends ItemView {
	host: NotionHost;
	private body!: HTMLElement;
	private dragNode: PageNode | null = null;
	private nodes = new Map<string, PageNode>();
	private expanded: Set<string>;
	private refreshSoon = debounce(() => this.render(), 120, true);

	constructor(leaf: WorkspaceLeaf, host: NotionHost) {
		super(leaf);
		this.host = host;
		this.expanded = new Set(host.state.treeExpanded);
	}
	getViewType() { return TREE_VIEW; }
	getDisplayText() { return '页面'; }
	getIcon() { return 'notebook-tabs'; }

	async onOpen() {
		this.containerEl.addClass('n-tree-view');
		const c = this.contentEl; c.empty(); c.addClass('n-sidebar');
		this.body = c.createDiv({ cls: 'n-tree-body' });
		const { app } = this;
		const r = () => this.refreshSoon();
		this.registerEvent(app.vault.on('create', r));
		this.registerEvent(app.vault.on('delete', r));
		this.registerEvent(app.vault.on('rename', (f, old) => {
			// keep expanded state / stored order when a page moves or is renamed
			if (this.expanded.delete(old)) this.expanded.add(f.path);
			const o = this.host.state.treeOrder;
			for (const k of Object.keys(o)) o[k] = o[k].map(x => (x === old ? f.path : x.startsWith(old + '/') ? f.path + x.slice(old.length) : x));
			if (o[old]) { o[f.path] = o[old]; delete o[old]; }
			r();
		}));
		this.registerEvent(app.metadataCache.on('resolved', r));
		this.watchRowDrags();
		this.registerEvent(app.metadataCache.on('changed', (f, _d, cache) => { if (cache.frontmatter?.['notion-icon'] !== undefined || this.nodes.has(f.path)) r(); }));
		this.registerEvent(app.workspace.on('file-open', () => this.markActive()));
		const l = () => r();
		this.host.icons.listeners.add(l);
		this.register(() => this.host.icons.listeners.delete(l));
		this.register(onEmojiReady(l));
		this.render();
	}

	// ---------------------------------------------------------------- render
	render() {
		if (!this.body) return;
		const scroll = this.body.scrollTop;
		this.nodes.clear();
		this.body.empty();
		const host = this.host;

		// workspace header (Notion: workspace name ▾) + ··· menu
		const ws = this.body.createDiv({ cls: 'n-sb-workspace' });
		ws.createDiv({ cls: 'n-sb-avatar', text: (this.app.vault.getName() || 'N').slice(0, 1).toUpperCase() });
		ws.createDiv({ cls: 'n-sb-ws-name', text: this.app.vault.getName() });
		const more = ws.createDiv({ cls: 'n-sb-ws-more clickable-icon', attr: { 'aria-label': '更多' } });
		setIcon(more, 'more-horizontal');
		more.onclick = ev => this.workspaceMenu(ev);
		const np = ws.createDiv({ cls: 'n-sb-ws-new clickable-icon', attr: { 'aria-label': '新建页面 (Ctrl+N)' } });
		setIcon(np, 'square-pen');
		np.onclick = () => void host.newPage(null);

		const quick = this.body.createDiv({ cls: 'n-sb-quick' });
		this.quickRow(quick, 'search', '搜索', () => host.openSearch(), 'Ctrl+P');
		const rp = host.reportPath();
		if (rp) this.quickRow(quick, 'clipboard-check', '导入报告', () => { const f = this.app.vault.getAbstractFileByPath(rp); if (f instanceof TFile) void host.openFile(f); });
		this.quickRow(quick, 'settings', '设置', () => host.openSettings());

		// favourites = Obsidian bookmarks (private API, optional)
		const favs = this.bookmarkedFiles();
		if (favs.length) {
			const sec = this.section('收藏');
			for (const f of favs) { const n = this.host.model.nodeForFile(f); if (n) this.renderNode(sec, { ...n, key: 'fav:' + n.key }, 0, true); }
		}
		const priv = this.section('私人', () => void host.newPage(null));
		const top = this.ordered(null);
		if (!top.length) priv.createDiv({ cls: 'n-tree-empty', text: '还没有页面' });
		for (const n of top) this.renderNode(priv, n, 0);
		const add = this.body.createDiv({ cls: 'n-tree-row n-tree-add' });
		setIcon(add.createDiv({ cls: 'n-tree-icon' }), 'plus');
		add.createDiv({ cls: 'n-tree-title', text: '新建页面' });
		add.onclick = () => void host.newPage(null);

		emojifyText(this.body);
		this.body.scrollTop = scroll;
		this.markActive();
	}

	private quickRow(parent: HTMLElement, icon: string, text: string, cb: () => void, hint?: string) {
		const row = parent.createDiv({ cls: 'n-tree-row n-sb-quick-row' });
		setIcon(row.createDiv({ cls: 'n-tree-icon' }), icon);
		row.createDiv({ cls: 'n-tree-title', text });
		if (hint) row.createDiv({ cls: 'n-sb-hint', text: hint });
		row.onclick = cb;
	}

	private section(title: string, onAdd?: () => void): HTMLElement {
		const s = this.body.createDiv({ cls: 'n-sb-section' });
		const h = s.createDiv({ cls: 'n-sb-section-title' });
		h.createSpan({ text: title });
		if (onAdd) {
			const b = h.createDiv({ cls: 'n-sb-section-add clickable-icon', attr: { 'aria-label': '添加页面' } });
			setIcon(b, 'plus');
			b.onclick = ev => { ev.stopPropagation(); onAdd(); };
		}
		return s.createDiv({ cls: 'n-sb-section-body' });
	}

	private bookmarkedFiles(): TFile[] {
		try {
			const bm = (this.app as any).internalPlugins?.getPluginById?.('bookmarks');
			if (!bm?.enabled) return [];
			const items: any[] = bm.instance?.getItemsFlat?.() ?? bm.instance?.items ?? [];
			return items.filter(i => i?.type === 'file' && i.path).map(i => this.app.vault.getAbstractFileByPath(i.path)).filter((f): f is TFile => f instanceof TFile);
		} catch { return []; }
	}

	/** children in stored order (user drags) falling back to Notion's order (links in the parent page) */
	private ordered(parent: PageNode | null): PageNode[] {
		const model = this.host.model;
		const kids = model.defaultOrder(parent, model.children(parent));
		const key = parent ? parent.key : '';
		const stored = this.host.state.treeOrder[key];
		if (!stored?.length) return kids;
		const idx = new Map(stored.map((k, i) => [k, i]));
		const known = kids.filter(k => idx.has(k.key)).sort((a, b) => idx.get(a.key)! - idx.get(b.key)!);
		const rest = kids.filter(k => !idx.has(k.key));
		// unknown (new) pages keep their natural place relative to the stored ones: appended at the end like Notion
		return [...known, ...rest];
	}

	private renderNode(parent: HTMLElement, node: PageNode, depth: number, fav = false) {
		if (!fav) this.nodes.set(node.key, node);
		const item = parent.createDiv({ cls: 'n-tree-item', attr: { 'data-key': node.key, 'data-kind': node.kind } });
		const row = item.createDiv({ cls: 'n-tree-row' });
		row.style.paddingInlineStart = `${8 + depth * 14}px`;
		const open = this.expanded.has(node.key);
		const canExpand = node.kind !== 'database';

		// icon slot: the page icon; on hover it turns into the expand arrow (Notion)
		const slot = row.createDiv({ cls: 'n-tree-icon' + (canExpand ? ' can-expand' : '') });
		const iconVal = node.file ? this.host.icons.iconFor(node.file.path) : undefined;
		if (iconVal) slot.appendChild(this.host.icons.makeIcon(iconVal, node.file!.path, 'is-tree'));
		else setIcon(slot.createSpan({ cls: 'n-tree-default-icon' }), node.kind === 'database' ? 'table-2' : node.kind === 'folder' ? 'folder' : 'file-text');
		if (canExpand) {
			const arrow = slot.createDiv({ cls: 'n-tree-arrow' + (open ? ' is-open' : '') });
			setIcon(arrow, 'chevron-right');
			arrow.onclick = ev => { ev.stopPropagation(); this.toggle(node); };
		}
		row.createDiv({ cls: 'n-tree-title', text: node.title });
		const tip = this.tooltipOf(node);
		if (tip) { row.setAttr('aria-label', tip); row.setAttr('data-tooltip-position', 'right'); row.addClass('n-tree-holder'); }
		const acts = row.createDiv({ cls: 'n-tree-actions' });
		const m = acts.createDiv({ cls: 'n-tree-act clickable-icon', attr: { 'aria-label': '删除、复制等…' } });
		setIcon(m, 'more-horizontal');
		m.onclick = ev => { ev.stopPropagation(); this.nodeMenu(ev, node); };
		if (node.kind !== 'folder' || node.folder) {
			const p = acts.createDiv({ cls: 'n-tree-act clickable-icon', attr: { 'aria-label': node.kind === 'database' ? '新建一行' : '在里面添加页面' } });
			setIcon(p, 'plus');
			p.onclick = async ev => {
				ev.stopPropagation();
				if (node.kind !== 'database') { this.expanded.add(node.key); this.saveExpanded(); }
				await this.host.newPage(fav ? (this.host.model.nodeForFile(node.file!) ?? node) : node, { link: true });
			};
		}
		row.onclick = ev => {
			if (node.file) void this.host.openFile(node.file, ev.ctrlKey || ev.metaKey || ev.button === 1);
			else this.toggle(node);
		};
		row.addEventListener('auxclick', ev => { if (ev.button === 1 && node.file) { ev.preventDefault(); void this.host.openFile(node.file, true); } });
		// round 8: touch long-press (≈0.5 s) opens the same menu (移动到… etc.); Android may also send contextmenu → once only
		let lp = 0, lpAt: { x: number; y: number } | null = null, lpOpened = 0;
		row.addEventListener('pointerdown', ev => {
			if (ev.pointerType === 'mouse') return;
			lpAt = { x: ev.clientX, y: ev.clientY };
			window.clearTimeout(lp);
			lp = window.setTimeout(() => { lpOpened = Date.now(); this.nodeMenu(new MouseEvent('contextmenu', { clientX: lpAt!.x, clientY: lpAt!.y }), node); }, 520);
		});
		row.addEventListener('pointermove', ev => { if (lpAt && Math.hypot(ev.clientX - lpAt.x, ev.clientY - lpAt.y) > 8) { window.clearTimeout(lp); lpAt = null; } });
		const lpEnd = () => { window.clearTimeout(lp); lpAt = null; };
		row.addEventListener('pointerup', lpEnd); row.addEventListener('pointercancel', lpEnd);
		row.addEventListener('click', ev => { if (Date.now() - lpOpened < 800) { ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
		row.addEventListener('contextmenu', ev => { ev.preventDefault(); if (Date.now() - lpOpened < 800) return; this.nodeMenu(ev, node); });
		if (!fav) this.dnd(row, node);

		if (open && canExpand) {
			const kids = item.createDiv({ cls: 'n-tree-children' });
			const list = this.ordered(node);
			if (!list.length) {
				const e = kids.createDiv({ cls: 'n-tree-empty', text: '里面没有页面' });
				e.style.paddingInlineStart = `${8 + (depth + 1) * 14 + 22}px`;
			}
			for (const k of list) this.renderNode(kids, k, depth + 1);
		}
	}

	private toggle(node: PageNode) {
		if (this.expanded.has(node.key)) this.expanded.delete(node.key); else this.expanded.add(node.key);
		this.saveExpanded();
		this.render();
	}
	private saveExpanded() { this.host.state.treeExpanded = [...this.expanded]; void this.host.save(); }

	/** expand the ancestors of a file and highlight its row */
	reveal(file: TFile) {
		let changed = false;
		for (const a of this.host.model.ancestors(file)) if (!this.expanded.has(a.key)) { this.expanded.add(a.key); changed = true; }
		if (changed) { this.saveExpanded(); this.render(); }
		this.markActive();
	}

	private markActive() {
		const f = this.app.workspace.getActiveFile();
		this.body?.querySelectorAll('.n-tree-row.is-active').forEach(e => e.removeClass('is-active'));
		if (!f) return;
		this.body?.querySelectorAll<HTMLElement>('.n-tree-item').forEach(it => { if (it.dataset.key === f.path) it.querySelector(':scope > .n-tree-row')?.addClass('is-active'); });
	}

	// ---------------------------------------------------------------- menus
	private workspaceMenu(ev: MouseEvent) {
		const m = new Menu();
		m.addItem(i => i.setTitle('新建页面').setIcon('square-pen').onClick(() => void this.host.newPage(null)));
		m.addItem(i => i.setTitle('搜索').setIcon('search').onClick(() => this.host.openSearch()));
		m.addItem(i => i.setTitle('命令面板').setIcon('terminal-square').onClick(() => this.host.runCommand('command-palette:open')));
		m.addSeparator();
		m.addItem(i => i.setTitle('从 Notion 备份 / 同步…').setIcon('download').onClick(() => this.host.runCommand('notion-lookalike-importer:import-notion-api')));
		const rp = this.host.reportPath();
		if (rp) m.addItem(i => i.setTitle('打开导入报告').setIcon('clipboard-check').onClick(() => { const f = this.app.vault.getAbstractFileByPath(rp); if (f instanceof TFile) void this.host.openFile(f); }));
		m.addItem(i => i.setTitle('设置').setIcon('settings').onClick(() => this.host.openSettings()));
		m.addSeparator();
		m.addItem(i => i.setTitle('关闭 Notion 模式（恢复 Obsidian 原始界面）').setIcon('log-out').onClick(() => void this.host.setNotionMode(false)));
		m.showAtMouseEvent(ev);
	}

	/** the generated "未归类的数据库" page (and the old "Databases" holder folder of v0.6 imports) */
	private isHolder(node: PageNode): boolean {
		if (node.file?.extension === 'md') return this.app.metadataCache.getFileCache(node.file)?.frontmatter?.['notion-holder'] === 'unclassified';
		return false;
	}
	private tooltipOf(node: PageNode): string | null {
		if (this.isHolder(node)) return '这些数据库在 Notion 里所在的页面没有共享给 integration，所以先放在这里。\n在 Notion 里把上级页面也共享给 integration 再同步，它们会自动回到原位；\n不需要的话可以删除，或选「以后不再同步」。';
		return null;
	}

	private nodeMenu(ev: MouseEvent, node: PageNode) {
		const { app, host } = this;
		const m = new Menu();
		if (node.file) {
			const file = node.file;
			m.addItem(i => i.setTitle('在新标签页打开').setIcon('file-plus').onClick(() => void host.openFile(file, true)));
			m.addItem(i => i.setTitle('复制链接').setIcon('link').onClick(async () => {
				const active = app.workspace.getActiveFile();
				await navigator.clipboard.writeText(app.fileManager.generateMarkdownLink(file, active?.path ?? ''));
				new Notice('已复制页面链接');
			}));
			m.addSeparator();
			m.addItem(i => i.setTitle('重命名').setIcon('pencil').onClick(() => this.inlineRename(node)));
			if (node.kind === 'page') m.addItem(i => i.setTitle('创建副本').setIcon('copy').onClick(async () => { const c = await duplicatePage(app, node); if (c) new Notice(`已创建副本“${c.basename}”`); }));
			m.addItem(i => i.setTitle('移动到…').setIcon('corner-up-right').onClick(() => this.moveTo(node)));
			this.syncItem(m, node);
			m.addSeparator();
			m.addItem(i => i.setTitle('删除').setIcon('trash-2').setWarning(true).onClick(() => this.confirmDelete(node)));
		} else {
			m.addItem(i => i.setTitle('重命名文件夹').setIcon('pencil').onClick(() => this.inlineRename(node)));
			m.addItem(i => i.setTitle('移动到…').setIcon('corner-up-right').onClick(() => this.moveTo(node)));
			m.addSeparator();
			m.addItem(i => i.setTitle('删除').setIcon('trash-2').setWarning(true).onClick(() => this.confirmDelete(node)));
		}
		m.showAtMouseEvent(ev);
	}

	/** "以后不再同步" for an imported page / database (async: the id is read from the file) */
	private syncItem(m: Menu, node: PageNode) {
		const host = this.host, file = node.file;
		if (!file || !host.notionIdOf || !host.setIgnored) return;
		if (file.extension === 'md' && !this.app.metadataCache.getFileCache(file)?.frontmatter?.['notion-id']) return;   // not from Notion
		const item = { done: false };
		m.addItem(i => {
			i.setTitle('以后不再同步').setIcon('cloud-off').setDisabled(true);
			void host.notionIdOf!(file).then(id => {
				if (item.done) return;
				if (!id) { i.setTitle('以后不再同步（不是从 Notion 导入的）'); return; }
				const ign = host.isIgnored?.(id) ?? false;
				i.setTitle(ign ? '恢复从 Notion 同步' : '以后不再同步').setIcon(ign ? 'cloud' : 'cloud-off').setDisabled(false);
				i.onClick(async () => { await host.setIgnored!(file, !ign); this.render(); });
			});
		});
		m.onHide(() => { item.done = true; });
	}

	/** .base files of the databases inside a holder / folder (for "delete + never sync again") */
	private basesUnder(node: PageNode): TFile[] {
		const out: TFile[] = [];
		const walk = (f: TFolder) => { for (const c of f.children) { if (c instanceof TFolder) walk(c); else if (c instanceof TFile && c.extension === 'base') out.push(c); } };
		if (node.folder) walk(node.folder);
		return out;
	}

	private confirmDelete(node: PageNode) {
		const subs = node.folder ? node.folder.children.filter(c => c instanceof TFile ? /^(md|base)$/.test(c.extension) : true).length : 0;
		const msg = subs ? `“${node.title}”和它里面的 ${subs} 个子页面/文件夹会被移到回收站。` : `“${node.title}”会被移到回收站。`;
		const m = new Menu();
		m.addItem(i => i.setTitle(msg).setDisabled(true));
		m.addItem(i => i.setTitle('移到回收站').setIcon('trash-2').setWarning(true).onClick(async () => { await trashPage(this.app, node); new Notice(`已把“${node.title}”移到回收站。下次从 Notion 同步时会重新下载它，除非选「以后不再同步」`, 8000); }));
		// imported from Notion: the next re-sync would bring it back → offer to stop syncing it too
		const bases = node.kind === 'database' && node.file ? [node.file] : this.basesUnder(node);
		const self = node.file && node.kind === 'page' ? [node.file] : [];
		if (this.host.setIgnored && (bases.length || self.length)) {
			m.addItem(i => i.setTitle('移到回收站，并且以后不再同步').setIcon('cloud-off').setWarning(true).onClick(async () => {
				let n = 0;
				for (const f of [...self, ...bases]) if (await this.host.setIgnored!(f, true)) n++;
				await trashPage(this.app, node);
				new Notice(`已把“${node.title}”移到回收站；${n} 个页面/数据库以后不再从 Notion 同步（设置里可以恢复）`, 8000);
			}));
		}
		m.addItem(i => i.setTitle('取消').setIcon('x'));
		const row = this.body.querySelector<HTMLElement>(`.n-tree-item[data-key="${CSS.escape(node.key)}"] > .n-tree-row`);
		const r = row?.getBoundingClientRect();
		m.showAtPosition({ x: (r?.left ?? 40) + 20, y: (r?.bottom ?? 100) });
	}

	private inlineRename(node: PageNode) {
		const row = this.body.querySelector<HTMLElement>(`.n-tree-item[data-key="${CSS.escape(node.key)}"] > .n-tree-row`);
		const title = row?.querySelector<HTMLElement>('.n-tree-title');
		if (!row || !title) return;
		const input = createEl('input', { cls: 'n-tree-rename', attr: { type: 'text', value: node.title } });
		title.replaceWith(input);
		input.focus(); input.select();
		let done = false;
		const finish = async (ok: boolean) => {
			if (done) return; done = true;
			const v = input.value.trim();
			if (ok && v && v !== node.title) {
				if (node.kind === 'folder' && node.folder) {
					const pp = node.folder.parent && node.folder.parent.path !== '/' ? node.folder.parent.path + '/' : '';
					await this.app.fileManager.renameFile(node.folder, pp + v);
				} else await renamePage(this.app, node, v);
			}
			this.render();
		};
		input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') void finish(true); if (ev.key === 'Escape') void finish(false); });
		input.addEventListener('blur', () => void finish(true));
		input.addEventListener('click', ev => ev.stopPropagation());
	}

	private moveTo(node: PageNode) {
		(this.host as any).pickPage?.('移动到…', async (target: PageNode | null) => {
			const dest = target ? await subPageFolder(this.app, this.host.model, target, this.host.topFolder()) : this.host.topFolder();
			if (await movePage(this.app, node, dest)) new Notice(`已移动到“${target?.title ?? '顶层'}”`);
		}, node);
	}

	// ---------------------------------------------------------------- drag and drop
	private dnd(row: HTMLElement, node: PageNode) {
		row.draggable = true;
		row.addEventListener('dragstart', ev => {
			this.dragNode = node;
			ev.dataTransfer?.setData('text/plain', node.file ? this.app.fileManager.generateMarkdownLink(node.file, '') : node.title);
			if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
			row.addClass('is-dragging');
		});
		row.addEventListener('dragend', () => { this.dragNode = null; row.removeClass('is-dragging'); this.clearDrop(); });
		row.addEventListener('dragover', ev => {
			// a file dragged from elsewhere in Obsidian (e.g. a database row out of a Bases table): drop INTO a page
			const ext = !this.dragNode ? this.externalNode() : null;
			if (ext && node.kind === 'page' && node.file !== ext.file && !this.isInside(node, ext)) { ev.preventDefault(); this.clearDrop(); row.addClass('drop-inside'); return; }
			const d = this.dragNode;
			if (!d || d.key === node.key || this.isInside(node, d)) return;
			ev.preventDefault();
			const zone = this.zone(ev, row, node);
			this.clearDrop();
			row.addClass('drop-' + zone);
		});
		row.addEventListener('dragleave', () => row.removeClass('drop-before', 'drop-after', 'drop-inside'));
		row.addEventListener('drop', async ev => {
			const ext = !this.dragNode ? this.externalNode() : null;
			if (ext && node.kind === 'page' && node.file !== ext.file && !this.isInside(node, ext)) {
				ev.preventDefault(); ev.stopPropagation(); this.clearDrop();
				await this.drop(ext, node, 'inside');
				return;
			}
			const d = this.dragNode;
			this.clearDrop();
			if (!d || d.key === node.key || this.isInside(node, d)) return;
			ev.preventDefault();
			await this.drop(d, node, this.zone(ev, row, node));
		});
	}
	/** a database row dragged out of a Bases table / board / gallery (its name link or card) – set on dragstart */
	private rowDrag: TFile | null = null;
	private externalNode(): PageNode | null {
		return this.rowDrag ? this.host.model.nodeForFile(this.rowDrag) : null;
	}
	private watchRowDrags() {
		this.registerDomEvent(document, 'dragstart', ev => {
			const f = rowFileFromElement(this.app, ev.target as Element);   // shared with the calendar (round 8.1)
			this.rowDrag = f && !(ev.target as Element).closest?.('.n-cal-item, .n-nodate-item') ? f : null;
		}, { capture: true });
		this.registerDomEvent(document, 'dragend', () => { window.setTimeout(() => { this.rowDrag = null; }, 50); }, { capture: true });
	}
	private zone(ev: DragEvent, row: HTMLElement, node: PageNode): Zone {
		const r = row.getBoundingClientRect(); const y = (ev.clientY - r.top) / r.height;
		if (node.kind === 'database') return y < 0.5 ? 'before' : 'after';
		return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
	}
	private clearDrop() { this.body.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(e => e.removeClass('drop-before', 'drop-after', 'drop-inside')); }
	/** is `target` the dragged node itself or one of its descendants? */
	private isInside(target: PageNode, dragged: PageNode): boolean {
		const f = dragged.folder?.path;
		return !!f && (target.key === f || target.key.startsWith(f + '/'));
	}

	private parentNode(n: PageNode): PageNode | null {
		const el = this.body.querySelector<HTMLElement>(`.n-tree-item[data-key="${CSS.escape(n.key)}"]`)?.parentElement?.closest<HTMLElement>('.n-tree-item');
		return el ? this.nodes.get(el.dataset.key || '') ?? null : null;
	}

	private async drop(d: PageNode, target: PageNode, zone: Zone) {
		const { app, host } = this;
		if (zone === 'inside') {
			const dest = await subPageFolder(app, host.model, target, host.topFolder());
			if (await movePage(app, d, dest)) { this.expanded.add(target.key); this.saveExpanded(); new Notice(`已把“${d.title}”移到“${target.title}”里`); }
			return;
		}
		const parent = this.parentNode(target);
		const destFolder = target.parentKey === '/' ? '' : target.parentKey;
		let key = d.key;
		// top-level rows can live in different folders (vault root, the lifted import folder): reorder only
		const topLevel = (k: string) => k === '/' || k === '' || k === host.model.flatten();
		const sameLevel = parent === null ? topLevel(d.parentKey) && this.parentNode(d) === null : (d.parentKey === '/' ? '' : d.parentKey) === destFolder;
		if (!sameLevel) {
			if (!(await movePage(app, d, destFolder || '/'))) return;
			const moved = d.file ? (d.kind === 'database' && d.folder ? `${destFolder ? destFolder + '/' : ''}${d.folder.name}/${d.file.name}` : `${destFolder ? destFolder + '/' : ''}${d.file.name}`) : `${destFolder ? destFolder + '/' : ''}${d.title}`;
			key = moved;
		}
		// stored order of the destination parent
		const pk = parent ? parent.key : '';
		const sibs = this.ordered(parent).map(n => n.key).filter(k => k !== key && k !== d.key);
		let i = sibs.indexOf(target.key);
		if (i < 0) i = sibs.length;
		sibs.splice(zone === 'after' ? i + 1 : i, 0, key);
		host.state.treeOrder[pk] = sibs;
		await host.save();
		this.render();
	}
}

export function isTreeFolder(f: unknown): f is TFolder { return f instanceof TFolder; }
