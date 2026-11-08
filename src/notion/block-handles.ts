/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion block handles in the editor (CodeMirror 6 view plugin, Notion mode only).
// Hover a block → "＋" (new block below, opens the "/" menu) and "⋮⋮" (drag to move · click for the block menu:
// 删除 / 复制 / 转换为 / 颜色 / 转为页面 / 移动到…). Dragging onto a page in the page tree moves the block there.
// Every action is one plain-text edit of the Markdown (one undo step); the block model is src/notion/block-model.ts.
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { Menu, type MenuItem, Notice, TFile, editorInfoField, setIcon } from 'obsidian';
import type { NotionHost } from './host.ts';
import { appendBlock, blockAsPage, blockAt, blockContent, colorBlock, duplicateBlock, ensureBlockId, moveBlock, moveBlockStep, parseBlocks, removeBlock, replaceBlock, turnInto, type Block, type TurnInto } from './block-model.ts';
import { subPageFolder, uniquePath } from './pages.ts';
import { emojifyText } from '../emoji.ts';

const TURN: [TurnInto, string, string][] = [
	['text', '文本', 'type'], ['h1', '标题 1', 'heading-1'], ['h2', '标题 2', 'heading-2'], ['h3', '标题 3', 'heading-3'],
	['todo', '待办事项', 'check-square'], ['bullet', '项目符号列表', 'list'], ['numbered', '编号列表', 'list-ordered'],
	['toggle', '折叠列表', 'chevron-right-square'], ['quote', '引用', 'quote'], ['callout', '标注', 'message-square'], ['code', '代码', 'code'],
];
const COLORS: [string | null, string][] = [[null, '默认'], ['gray', '灰色'], ['brown', '棕色'], ['orange', '橙色'], ['yellow', '黄色'], ['green', '绿色'], ['blue', '蓝色'], ['purple', '紫色'], ['pink', '粉色'], ['red', '红色']];
const HEX: Record<string, string> = { gray: '#9b9a97', brown: '#a27763', orange: '#d9730d', yellow: '#dfab01', green: '#4d9b73', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47' };

/** minimal single change turning a into b (one transaction, cursor-friendly) */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) s++;
	let e = 0;
	while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
	return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

/** Obsidian's Menu has no public submenu API: use the private one when present, else open a second menu */
function submenu(item: MenuItem, build: (m: Menu) => void, at: () => { x: number; y: number }) {
	const sub = (item as any).setSubmenu?.();
	if (sub) { build(sub); return; }
	item.onClick(() => { const m = new Menu(); build(m); m.showAtPosition(at()); });
}

export function blockHandleExtension(host: NotionHost, enabled: () => boolean) {
	const app = host.app;
	return ViewPlugin.fromClass(class {
		view: EditorView;
		handle: HTMLElement;
		drop: HTMLElement;
		ghost: HTMLElement | null = null;
		cur: Block | null = null;
		blocks: Block[] | null = null;
		dragging = false;
		hideTimer = 0;
		treeTarget: HTMLElement | null = null;
		private listeners: [EventTarget, string, EventListener][] = [];

		constructor(view: EditorView) {
			this.view = view;
			this.handle = createDiv({ cls: 'n-bh' });
			const add = this.handle.createDiv({ cls: 'n-bh-btn n-bh-add', attr: { 'aria-label': '点击在下方添加块' } });
			setIcon(add, 'plus');
			const grip = this.handle.createDiv({ cls: 'n-bh-btn n-bh-grip', attr: { 'aria-label': '拖动以移动\n点击打开菜单' } });
			setIcon(grip, 'grip-vertical');
			this.drop = createDiv({ cls: 'n-bh-drop' });
			view.dom.appendChild(this.handle); view.dom.appendChild(this.drop);
			this.on(view.dom, 'mousemove', e => this.hover(e as MouseEvent));
			this.on(view.dom, 'mouseleave', () => this.hideSoon());
			this.on(this.handle, 'mouseenter', () => window.clearTimeout(this.hideTimer));
			this.on(view.scrollDOM, 'scroll', () => { if (!this.dragging) this.hide(); });
			this.on(add, 'mousedown', e => { e.preventDefault(); e.stopPropagation(); });
			this.on(add, 'click', e => { e.preventDefault(); this.addBelow(); });
			// round 8: pointer events → mouse, pen and touch (tap ⋮⋮ = menu; drag works with a finger too)
			this.on(grip, 'pointerdown', e => this.gripDown(e as PointerEvent));
			this.on(add, 'pointerdown', e => { if ((e as PointerEvent).pointerType !== 'mouse') { e.preventDefault(); e.stopPropagation(); this.addBelow(); } });
			// touch has no hover: a tap in the text shows the handle of that block (and keeps it visible)
			this.on(view.dom, 'pointerdown', e => { const pe = e as PointerEvent; if (pe.pointerType !== 'mouse' && !(pe.target as HTMLElement).closest('.n-bh')) { this.touchShown = true; this.hover(pe); } });
			// Esc selects the block (Notion); then ↑/↓ moves the selection, Delete/Backspace deletes, Esc/typing leaves it
			this.on(view.contentDOM, 'keydown', e => this.selectionKey(e as KeyboardEvent), true);
			this.on(view.dom, 'pointerdown', () => this.unselect());
		}
		touchShown = false;
		selected: Block | null = null;
		private on(t: EventTarget, ev: string, fn: EventListener, capture = false) { t.addEventListener(ev, fn, capture); this.listeners.push([t, ev, fn]); }
		update(u: ViewUpdate) { if (u.docChanged) { this.blocks = null; if (!this.dragging && !this.touchShown) this.hide(); if (this.selected) this.paintSelection(); } }
		destroy() { for (const [t, e, f] of this.listeners) { t.removeEventListener(e, f); t.removeEventListener(e, f, true); } this.handle.remove(); this.drop.remove(); this.ghost?.remove(); }

		get file(): TFile | null { return this.view.state.field(editorInfoField, false)?.file ?? null; }
		get lines(): string[] { return this.view.state.doc.toString().split('\n'); }
		getBlocks(): Block[] { return (this.blocks ??= parseBlocks(this.lines)); }
		locked(): boolean { const f = this.file; const c = f ? app.metadataCache.getFileCache(f)?.frontmatter?.cssclasses : null; return (Array.isArray(c) ? c : [c]).includes('notion-locked'); }

		/** block under a screen point (y decides; x is clamped into the text column) */
		blockAtY(x: number, y: number): Block | null {
			const r = this.view.contentDOM.getBoundingClientRect();
			const pos = this.view.posAtCoords({ x: Math.max(r.left + 30, Math.min(x, r.right - 10)), y }, false);
			if (pos === null || pos === undefined) return null;
			return blockAt(this.getBlocks(), this.view.state.doc.lineAt(pos).number - 1);
		}
		/** screen rectangle of a block (handles Live Preview widgets: callouts, tables, embeds) */
		rect(b: Block): { top: number; bottom: number; left: number; firstH: number } {
			const doc = this.view.state.doc;
			const l1 = doc.line(b.from + 1), l2 = doc.line(Math.min(b.to + 1, doc.lines));
			const top = this.view.documentTop + this.view.lineBlockAt(l1.from).top;
			const lb2 = this.view.lineBlockAt(l2.to);
			const bottom = this.view.documentTop + lb2.bottom;
			const firstH = this.view.lineBlockAt(l1.from).height;
			let left = this.view.contentDOM.getBoundingClientRect().left;
			const c = this.view.coordsAtPos(l1.from + b.indent.length);
			if (c && c.left > left - 1 && c.left < left + 400) left = c.left;
			return { top, bottom, left, firstH };
		}

		hover(e: MouseEvent) {
			if (this.dragging) return;
			if (!enabled() || !this.file || this.locked() || (e.target as HTMLElement).closest('.n-bh, .metadata-container, .inline-title, .notion-header, .cm-embed-block .bases-view')) {
				if (!(e.target as HTMLElement).closest('.n-bh')) this.hideSoon();
				return;
			}
			const b = this.blockAtY(e.clientX, e.clientY);
			if (!b) { this.hideSoon(); return; }
			window.clearTimeout(this.hideTimer);
			this.cur = b;
			const r = this.rect(b);
			const host = this.view.dom.getBoundingClientRect();
			const h = Math.min(r.firstH, 30);
			this.handle.style.top = `${r.top - host.top + Math.max(0, (h - 24) / 2) + (b.kind === 'callout' || b.kind === 'toggle' || b.kind === 'code' || b.kind === 'table' ? 4 : 0)}px`;
			this.handle.style.left = `${Math.max(0, r.left - host.left - 50)}px`;
			this.handle.addClass('is-visible');
		}
		hideSoon() { if (this.touchShown) return; window.clearTimeout(this.hideTimer); this.hideTimer = window.setTimeout(() => this.hide(), 250); }
		hide() { this.handle.removeClass('is-visible'); }

		/** apply a new full text as one minimal change */
		apply(text: string, cursorLine?: number) {
			const old = this.view.state.doc.toString();
			if (text === old) return;
			const ch = minimalChange(old, text);
			const tr: any = { changes: ch, userEvent: 'input' };
			if (cursorLine !== undefined) {
				const after = this.view.state.update({ changes: ch }).state.doc;
				const ln = after.line(Math.max(1, Math.min(cursorLine + 1, after.lines)));
				tr.selection = { anchor: ln.to };
			}
			this.view.dispatch(tr);
			this.blocks = null;
		}

		// ---------------------------------------------------------------- ＋
		addBelow() {
			const b = this.cur; if (!b) return;
			const lines = this.lines;
			const list = b.kind === 'list';
			const prefix = list ? b.indent + (/^\s*\d+[.)]/.test(lines[b.from]) ? '1. ' : /^\s*[-*+]\s+\[.\]/.test(lines[b.from]) ? '- [ ] ' : '- ') : '';
			const ins = list ? [prefix] : ['', ''];
			const out = [...lines.slice(0, b.to + 1), ...ins, ...lines.slice(b.to + 1)];
			const line = b.to + ins.length;
			// a blank line must follow a new paragraph line when the next block starts right after
			if (!list && out[line + 1] !== undefined && out[line + 1].trim() !== '') out.splice(line + 1, 0, '');
			this.apply(out.join('\n'), line);
			this.view.focus();
			// Notion opens the block menu on the new line: type "/" like the user would (opens our "/" menu)
			if (!list) window.setTimeout(() => { const p = this.view.state.selection.main.head; this.view.dispatch({ changes: { from: p, insert: '/' }, selection: { anchor: p + 1 }, userEvent: 'input.type' }); }, 30);
			this.hide();
		}

		// ---------------------------------------------------------------- ⋮⋮ drag / click
		gripDown(e: PointerEvent) {
			if (e.button !== 0) return;
			e.preventDefault(); e.stopPropagation();
			const src = this.cur; if (!src) return;
			const x0 = e.clientX, y0 = e.clientY;
			const slop = e.pointerType === 'mouse' ? 4 : 10;
			let started = false;
			let target: { b: Block; where: 'before' | 'after' } | null = null;
			const move = (ev: PointerEvent) => {
				if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < slop) return;
				if (!started) { started = true; this.startDrag(src); }
				this.ghost!.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
				target = this.dragOver(ev, src);
			};
			const up = async (ev: PointerEvent) => {
				window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
				if (!started) { this.menu(src, ev); return; }
				const tree = this.treeTarget;
				this.endDrag();
				if (tree) { await this.dropOnTree(src, tree); return; }
				if (target) this.apply(moveBlock(this.view.state.doc.toString(), src, target.b, target.where));
			};
			const cancel = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true); if (started) this.endDrag(); };
			window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true);
		}
		startDrag(src: Block) {
			this.dragging = true;
			document.body.addClass('n-bh-dragging');
			const lead = blockContent(this.lines, src).lead;
			const text = (src.kind === 'code' ? '代码块' : src.kind === 'table' ? '表格' : lead.replace(/<[^>]+>/g, '').replace(/[*_`=]/g, '').trim()).slice(0, 60) || '块';
			this.ghost = document.body.createDiv({ cls: 'n-bh-ghost', text });
			emojifyText(this.ghost);
			const r = this.rect(src); const host = this.view.dom.getBoundingClientRect();
			const shade = this.view.dom.createDiv({ cls: 'n-bh-source' });
			shade.style.top = `${r.top - host.top}px`; shade.style.height = `${r.bottom - r.top}px`;
		}
		endDrag() {
			this.dragging = false;
			document.body.removeClass('n-bh-dragging');
			this.ghost?.remove(); this.ghost = null;
			this.view.dom.querySelectorAll('.n-bh-source').forEach(e => e.remove());
			this.drop.removeClass('is-visible');
			this.treeTarget?.removeClass('n-bh-tree-drop'); this.treeTarget = null;
			this.hide();
		}
		dragOver(ev: MouseEvent, src: Block): { b: Block; where: 'before' | 'after' } | null {
			// over the page tree: drop INTO that page / database (item 5)
			const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
			const row = el?.closest<HTMLElement>('.n-tree-item[data-kind="page"] > .n-tree-row, .n-tree-item[data-kind="database"] > .n-tree-row') ?? null;
			if (row !== this.treeTarget) { this.treeTarget?.removeClass('n-bh-tree-drop'); this.treeTarget = row; row?.addClass('n-bh-tree-drop'); }
			if (row) { this.drop.removeClass('is-visible'); return null; }
			const r0 = this.view.scrollDOM.getBoundingClientRect();
			if (ev.clientX < r0.left - 60 || ev.clientX > r0.right || ev.clientY < r0.top || ev.clientY > r0.bottom) { this.drop.removeClass('is-visible'); return null; }
			// auto-scroll near the edges
			if (ev.clientY < r0.top + 40) this.view.scrollDOM.scrollTop -= 12; else if (ev.clientY > r0.bottom - 40) this.view.scrollDOM.scrollTop += 12;
			const b = this.blockAtY(ev.clientX, ev.clientY);
			if (!b || (b.from >= src.from && b.to <= src.to)) { this.drop.removeClass('is-visible'); return null; }
			const r = this.rect(b);
			const where = ev.clientY < (r.top + r.bottom) / 2 ? 'before' : 'after';
			const host = this.view.dom.getBoundingClientRect();
			this.drop.style.top = `${(where === 'before' ? r.top : r.bottom) - host.top - 2}px`;
			this.drop.style.left = `${r.left - host.left}px`;
			this.drop.style.width = `${Math.max(120, this.view.contentDOM.getBoundingClientRect().right - r.left - 20)}px`;
			this.drop.addClass('is-visible');
			return { b, where };
		}

		/** drop a block on a page / database in the sidebar: the block moves there (database: becomes a new row) */
		async dropOnTree(src: Block, row: HTMLElement) {
			const dest = app.vault.getAbstractFileByPath(row.parentElement?.dataset.key || '');
			if (dest instanceof TFile) await this.moveToFile(src, dest);
		}
		async moveToFile(src: Block, dest: TFile) {
			if (dest === this.file) return;
			const kind = dest.extension === 'base' ? 'database' : 'page';
			const lines = this.lines;
			const blockLines = lines.slice(src.from, src.to + 1);
			if (kind === 'database') {
				const node = host.model.nodeForFile(dest);
				const folder = node?.folder?.path ?? dest.parent?.path ?? '';
				const pg = blockAsPage(lines, src);
				const path = uniquePath(app, folder, pg.title, 'md');
				await app.vault.create(path, `---\ncssclasses:\n  - notion\n---\n${pg.body}`);
				new Notice(`已移到数据库“${dest.basename}”，成为新的一行“${pg.title}”`);
			} else {
				await app.vault.process(dest, t => appendBlock(t, blockLines, src.indent));
				new Notice(`已移到“${dest.basename}”`);
			}
			this.apply(removeBlock(this.view.state.doc.toString(), src));
		}

		// ---------------------------------------------------------------- block menu
		menu(b: Block, ev: MouseEvent) {
			const m = new Menu();
			const at = () => ({ x: ev.clientX + 160, y: ev.clientY });
			const text = () => this.view.state.doc.toString();
			const lines = () => this.lines;
			m.addItem(i => i.setTitle('删除').setIcon('trash-2').onClick(() => this.apply(removeBlock(text(), b))));
			m.addItem(i => i.setTitle('创建副本').setIcon('copy-plus').onClick(() => this.apply(duplicateBlock(text(), b))));
			m.addItem(i => i.setTitle('复制块链接').setIcon('link').onClick(() => void this.copyLink(b)));
			m.addItem(i => i.setTitle('上移').setIcon('arrow-up').onClick(() => this.step(b, -1)));
			m.addItem(i => i.setTitle('下移').setIcon('arrow-down').onClick(() => this.step(b, 1)));
			m.addItem(i => { i.setTitle('转换为').setIcon('repeat'); submenu(i, sm => {
				for (const [k, label, icon] of TURN) sm.addItem(x => x.setTitle(label).setIcon(icon).onClick(() => this.apply(replaceBlock(text(), b, turnInto(lines(), b, k)), b.from)));
			}, at); });
			m.addItem(i => i.setTitle('转为页面').setIcon('file-symlink').onClick(() => void this.toPage(b)));
			m.addItem(i => i.setTitle('移动到…').setIcon('corner-up-right').onClick(() => this.moveTo(b)));
			m.addSeparator();
			m.addItem(i => { i.setTitle('颜色').setIcon('palette'); submenu(i, sm => {
				const paint = (x: MenuItem, c: string | null, bg: boolean) => {
					const dom: HTMLElement | undefined = (x as any).dom;
					const ic = dom?.querySelector<HTMLElement>('.menu-item-icon');
					if (ic && c) { if (bg) { ic.style.background = HEX[c] + '33'; ic.style.borderRadius = '3px'; } else ic.style.color = HEX[c]; }
				};
				for (const [c, label] of COLORS) sm.addItem(x => { x.setTitle(`文字 · ${label}`).setIcon('type').onClick(() => this.apply(replaceBlock(text(), b, colorBlock(lines(), b, c, false)))); paint(x, c, false); });
				sm.addSeparator();
				for (const [c, label] of COLORS) sm.addItem(x => { x.setTitle(`背景 · ${label}`).setIcon('square').onClick(() => this.apply(replaceBlock(text(), b, colorBlock(lines(), b, c, true)))); paint(x, c, true); });
			}, at); });
			m.showAtMouseEvent(ev);
		}

		/** 上移 / 下移 (also Ctrl+Shift+↑/↓) */
		step(b: Block, dir: -1 | 1): boolean {
			const r = moveBlockStep(this.view.state.doc.toString(), b, dir);
			if (!r) return false;
			this.apply(r.text, r.line);
			if (this.selected) { this.selected = blockAt(this.getBlocks(), r.line); this.paintSelection(); }
			return true;
		}
		/** 复制块链接: gives the block an Obsidian ^id (reused when present) and copies [[page#^id]] */
		async copyLink(b: Block) {
			const f = this.file; if (!f) return;
			const fresh = Math.random().toString(36).slice(2, 8);
			const r = ensureBlockId(this.view.state.doc.toString(), b, fresh);
			this.apply(r.text);
			const link = `[[${f.path.replace(/\.md$/, '')}#^${r.id}|${f.basename}]]`;
			try { await navigator.clipboard.writeText(link); new Notice('已复制块链接，粘贴到任意页面即可链接到这个块'); }
			catch { new Notice('块链接：' + link, 8000); }
		}
		// ---------------------------------------------------------------- Esc block selection
		selectionKey(e: KeyboardEvent) {
			if (!enabled() || this.locked()) return;
			if (!this.selected) {
				if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
				if (document.querySelector('.suggestion-container, .menu, .modal-container')) return;   // Esc closes those first
				const line = this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1;
				const b = blockAt(this.getBlocks(), line);
				if (!b) return;
				e.preventDefault(); e.stopPropagation();
				this.selected = b; this.paintSelection();
				return;
			}
			const b = this.selected;
			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				e.preventDefault(); e.stopPropagation();
				const dir = e.key === 'ArrowUp' ? -1 : 1;
				if ((e.ctrlKey || e.metaKey) && e.shiftKey) { this.step(b, dir); return; }
				const bs = this.getBlocks().filter(x => x.depth === 0 || x.depth <= b.depth).sort((x, y) => x.from - y.from);
				const i = bs.findIndex(x => x.from === b.from);
				const n = bs[i + dir]; if (n) { this.selected = n; this.paintSelection(); }
				return;
			}
			if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); const t = removeBlock(this.view.state.doc.toString(), b); this.unselect(); this.apply(t, Math.max(0, b.from - 1)); return; }
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); e.stopPropagation(); this.apply(duplicateBlock(this.view.state.doc.toString(), b)); this.unselect(); return; }
			if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const ln = this.view.state.doc.line(b.from + 1); this.unselect(); this.view.dispatch({ selection: { anchor: ln.to } }); return; }
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
			if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) this.unselect();
		}
		paintSelection() {
			this.view.dom.querySelectorAll('.n-bh-selected').forEach(x => x.remove());
			const b = this.selected; if (!b) return;
			const r = this.rect(b); const host = this.view.dom.getBoundingClientRect();
			const el = this.view.dom.createDiv({ cls: 'n-bh-selected' });
			el.style.top = `${r.top - host.top}px`; el.style.height = `${r.bottom - r.top}px`;
			el.style.left = `${r.left - host.left - 4}px`; el.style.width = `${Math.max(80, this.view.contentDOM.getBoundingClientRect().right - r.left)}px`;
		}
		unselect() { if (!this.selected) return; this.selected = null; this.view.dom.querySelectorAll('.n-bh-selected').forEach(x => x.remove()); }

		/** Notion "Turn into page": the block's content becomes a sub-page; a link to it stays in its place */
		async toPage(b: Block) {
			const f = this.file; if (!f) return;
			const pg = blockAsPage(this.lines, b);
			const folder = await subPageFolder(app, host.model, host.model.nodeForFile(f), host.topFolder());
			const path = uniquePath(app, folder, pg.title, 'md');
			await app.vault.create(path, pg.body);
			this.apply(replaceBlock(this.view.state.doc.toString(), b, [`${b.indent}[[${path.replace(/\.md$/, '')}|${pg.title}]]`]));
			new Notice(`已转为页面“${pg.title}”`);
		}
		moveTo(b: Block) {
			host.pickPage?.('把块移动到…', async target => { if (target?.file) await this.moveToFile(b, target.file); }, null);
		}
	}, {});
}

/** Round 8 keyboard block commands (Ctrl+D 创建副本, Ctrl+Shift+↑/↓ 移动, Ctrl+Shift/Alt+0…9 转换为) on the block at
 *  the cursor; one plain-text edit each (one undo step). Returns false when there is no block there. */
export type BlockOp = { op: 'duplicate' } | { op: 'move'; dir: -1 | 1 } | { op: 'turn'; to: TurnInto };
export function runBlockOp(view: EditorView, o: BlockOp): boolean {
	const text = view.state.doc.toString();
	const lines = text.split('\n');
	const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
	const b = blockAt(parseBlocks(lines), line);
	if (!b) return false;
	let out: string | null = null; let cur = line;
	if (o.op === 'duplicate') { out = duplicateBlock(text, b); cur = line + (b.to - b.from + 1) + (b.kind === 'list' ? 0 : 1); }
	else if (o.op === 'move') { const r = moveBlockStep(text, b, o.dir); if (!r) return true; out = r.text; cur = r.line + (line - b.from); }
	else { out = replaceBlock(text, b, turnInto(lines, b, o.to)); cur = b.from; }
	if (out === null || out === text) return true;
	const ch = minimalChange(text, out);
	const after = view.state.update({ changes: ch }).state.doc;
	const ln = after.line(Math.max(1, Math.min(cur + 1, after.lines)));
	view.dispatch({ changes: ch, selection: { anchor: ln.to }, userEvent: 'input' });
	return true;
}
