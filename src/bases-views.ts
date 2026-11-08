/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion chart + calendar views as real Bases view types ("notion-chart", "notion-calendar").
// Being Bases views, they share the base's view list (and the Notion-style tab bar) with the table / board /
// gallery / list views, and Bases applies the view's own filters before we get the rows.
import { BasesView, Notice, type Plugin, type QueryController, TFile, normalizePath } from 'obsidian';
import type { Row } from './render/filter.ts';
import { toDom } from './render/hnode.ts';
import { renderCalendar, renderChart, type ChartSpec } from './render/views.ts';
import { applyDateEdit, dateString, dropOnDay, resizeEnd, sameDatabase, undatedRows, undoDateEdit, type DateEdit } from './render/calendar-edit.ts';
import { dropTargets, dropUndo, rowDrag, undoLastDrop, type RowDropTarget } from './notion/row-drag.ts';
import { uniquePath } from './notion/pages.ts';
import { UNTITLED } from './core/naming.ts';

/** "note.Status" / "file.name" / plain key → frontmatter key */
const fmKey = (v: unknown): string => String(v ?? '').replace(/^note\./, '');

abstract class NotionBasesView extends BasesView {
	protected el: HTMLElement;
	private raf = 0;
	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.el = containerEl.createDiv({ cls: 'n-bases-view' });
	}
	/** Rows with frontmatter; keys like "formula.X" (live Notion formulas / rollups) are read from Bases itself,
	 *  so charts and calendars show live values instead of a static copy. */
	protected rows(live: string[] = []): Row[] {
		const out: Row[] = [];
		for (const e of (this.data?.data || []) as any[]) {
			const f: TFile | undefined = e.file;
			if (!f) continue;
			const props: Record<string, unknown> = { ...(this.app.metadataCache.getFileCache(f)?.frontmatter || {}) };
			for (const k of live) {
				if (!k.startsWith('formula.')) continue;
				try { const v = e.getValue?.(k); const t = v == null ? '' : String(v.toString()); props[k] = t === 'null' ? '' : t; } catch { /* keep */ }
			}
			out.push({ name: f.basename, path: f.path, props });
		}
		return out;
	}
	onDataUpdated(): void {
		cancelAnimationFrame(this.raf);
		this.raf = requestAnimationFrame(() => { try { this.render(); } catch (e) { this.el.empty(); this.el.createEl('pre', { text: String(e) }); } });
	}
	onunload(): void { cancelAnimationFrame(this.raf); }
	protected abstract render(): void;
}

class ChartView extends NotionBasesView {
	type = 'notion-chart';
	protected render() {
		const c = this.config;
		const x = String(c.get('x') ?? '');
		const spec: ChartSpec = {
			source: '', title: '', chart: String(c.get('chartType') || 'column'),
			x: x === 'file.name' ? '__name' : fmKey(x), xType: c.get('xType') as string | undefined,
			dateGroup: c.get('dateGroup') as string | undefined, aggregate: c.get('aggregate') as string | undefined,
			sort: c.get('xSort') as string | undefined, colors: (c.get('colors') as Record<string, string>) || undefined,
		};
		const rows = this.rows([x]).map(r => (x === 'file.name' ? { ...r, props: { ...r.props, __name: r.name } } : r));
		this.el.empty();
		toDom(renderChart(spec, rows), this.el);
	}
}

class CalendarView extends NotionBasesView {
	type = 'notion-calendar';
	private shift = 0;   // months (month view) or weeks (week view) away from today, like Notion's ‹ Today ›
	private rangeOverride: string | null = null;
	private drag: { path: string; mode: 'move' | 'resize' } | null = null;
	private showUndated = false;
	private ctl: any;
	private target: RowDropTarget;
	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller, containerEl); this.ctl = controller;
		this.target = { el: this.el, accepts: f => this.accepts(f.path), drop: (f, day) => this.writeDate(f.path, day, 'move') };
	}
	onunload(): void { super.onunload(); dropTargets.delete(this.target); }
	private dateKey(): string { return fmKey(this.config.get('date')); }
	/** same database: one of this view's rows, or a note in the database's row folder */
	private accepts(path: string): boolean {
		return sameDatabase(path, { rowPaths: new Set(((this.data?.data || []) as any[]).map(e => e.file?.path).filter(Boolean)), folder: this.rowFolder() });
	}
	protected render() {
		const c = this.config;
		const range = this.rangeOverride ?? String(c.get('range') || 'month');
		const today = new Date();
		const shown = new Date(today);
		if (range === 'week') shown.setDate(shown.getDate() + 7 * this.shift); else shown.setMonth(shown.getMonth() + this.shift, 1);
		const dateKey = this.dateKey();
		const editable = !!dateKey && !dateKey.startsWith('formula.') && !dateKey.startsWith('file.');
		const rows = this.rows([dateKey]);
		this.el.empty();
		toDom(renderCalendar({ source: '', title: '', date: dateKey, range }, rows, shown, undefined, { nav: true, today, edit: editable }), this.el);
		this.el.querySelectorAll<HTMLAnchorElement>('a.n-cal-item').forEach(a => a.addEventListener('click', ev => {
			if ((ev.target as HTMLElement).closest('.n-cal-resize')) { ev.preventDefault(); return; }
			ev.preventDefault();
			this.open(a.dataset.path || '', a.dataset.href || '', ev);
		}));
		const on = (sel: string, d: number | null) => this.el.querySelector(sel)?.addEventListener('click', () => { this.shift = d === null ? 0 : this.shift + d; this.render(); });
		on('.n-cal-prev', -1); on('.n-cal-next', 1); on('.n-cal-today', null);
		const setRange = (r: string) => { this.rangeOverride = r; this.shift = 0; try { (c as any).set?.('range', r); } catch { /* read-only config */ } this.render(); };
		this.el.querySelector('.n-cal-month')?.addEventListener('click', () => setRange('month'));
		this.el.querySelector('.n-cal-week')?.addEventListener('click', () => setRange('week'));
		if (editable) { this.undatedList(rows, dateKey); this.wireEditing(dateKey); dropTargets.add(this.target); } else dropTargets.delete(this.target);
	}

	private open(path: string, href: string, ev: MouseEvent) {
		const f = this.app.vault.getAbstractFileByPath(path);
		const peek = calendarHooks.peek;
		if (f instanceof TFile && peek && !(ev.ctrlKey || ev.metaKey)) { void peek(f, this.el.closest('.workspace-leaf')); return; }
		void this.app.workspace.openLinkText(href || path, '', ev.ctrlKey || ev.metaKey);
	}

	/** Notion's 「无日期 (N)」: the rows without a date, draggable onto a day */
	private undatedList(rows: Row[], key: string) {
		const list = undatedRows(rows, key).sort((a, b) => a.name.localeCompare(b.name));
		const nav = this.el.querySelector('.n-cal-nav');
		if (!nav) return;
		const btn = createEl('button', { cls: 'n-cal-nodate' + (this.showUndated ? ' is-active' : ''), text: `无日期 (${list.length})`, attr: { 'aria-label': '没有日期的行：拖到某一天就有了日期' } });
		nav.prepend(btn);
		btn.addEventListener('click', () => { this.showUndated = !this.showUndated; this.render(); });
		if (!this.showUndated) return;
		const panel = createDiv({ cls: 'n-nodate-panel' });
		this.el.querySelector('.n-cal-top')?.after(panel);
		panel.createDiv({ cls: 'n-nodate-hint', text: list.length ? '把下面的行拖到日历上的某一天' : '所有行都有日期了' });
		for (const r of list) {
			const it = panel.createDiv({ cls: 'n-nodate-item', text: r.name, attr: { draggable: 'true', 'data-path': r.path } });
			it.addEventListener('click', ev => this.open(r.path, r.path, ev));
		}
	}

	/** Notion calendar editing, local only: drag = move to another day, drag the end edge = change the end of the
	 *  range, ＋ on a day = new row with that date, rows of the same database dragged from a table / board /
	 *  gallery / the 无日期 list get that day. Values are written to the row note's frontmatter. */
	private wireEditing(key: string) {
		this.el.querySelectorAll<HTMLElement>('.n-cal-item[draggable], .n-nodate-item[draggable]').forEach(a => {
			a.addEventListener('dragstart', ev => {
				const resize = (ev.target as HTMLElement).closest('.n-cal-resize');
				this.drag = { path: a.dataset.path || '', mode: resize ? 'resize' : 'move' };
				ev.dataTransfer?.setData('text/plain', a.dataset.path || '');
				if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
				a.addClass('is-dragging'); this.el.addClass('is-dragging');
			});
			a.addEventListener('dragend', () => { this.drag = null; a.removeClass('is-dragging'); this.el.removeClass('is-dragging'); this.clearDrop(); });
		});
		const dragged = (): { path: string; mode: 'move' | 'resize' } | null => {
			if (this.drag) return this.drag;
			const f = rowDrag.file;
			return f && this.accepts(f.path) ? { path: f.path, mode: 'move' } : null;   // other database → no indicator, no drop
		};
		this.el.querySelectorAll<HTMLElement>('.n-cal-cell[data-date]').forEach(cell => {
			cell.addEventListener('dragover', ev => {
				if (!dragged()) return;
				ev.preventDefault(); ev.stopPropagation();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
				this.el.querySelectorAll('.is-drop').forEach(e => e !== cell && e.removeClass('is-drop')); cell.addClass('is-drop');
			});
			cell.addEventListener('dragleave', ev => { if (!cell.contains(ev.relatedTarget as Node)) cell.removeClass('is-drop'); });
			cell.addEventListener('drop', async ev => {
				const d = dragged(); this.drag = null;
				cell.removeClass('is-drop');
				if (!d) return;
				ev.preventDefault(); ev.stopPropagation();   // keep the editor around an embedded base from inserting a link
				rowDrag.file = null;
				await this.writeDate(d.path, cell.dataset.date!, d.mode);
			});
			cell.querySelector('.n-cal-add')?.addEventListener('click', ev => { ev.stopPropagation(); void this.newRow(key, cell.dataset.date!); });
		});
	}
	private clearDrop() { this.el.querySelectorAll('.is-drop').forEach(e => e.removeClass('is-drop')); }

	/** one drop = one processFrontMatter call (= one change of the note) + one entry on the drop-undo stack */
	private async writeDate(path: string, day: string, mode: 'move' | 'resize') {
		const key = this.dateKey(), endKey = `${key} (end)`;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile) || !key) return;
		if (!this.accepts(path)) return;   // rows of another database are never written
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
		const start = dateString(fm[key]);
		const end = dateString(fm[endKey]);
		if (mode === 'resize' && !start) return;
		const r = mode === 'move' ? dropOnDay(start, end, day) : resizeEnd(start!, end, day);
		if (r.start === start && (r.end ?? null) === (end ?? null)) return;
		const edit: DateEdit = { path, key, endKey, before: { start: fm[key] === undefined ? undefined : fm[key], end: fm[endKey] === undefined ? undefined : fm[endKey] }, after: r, at: Date.now() };
		await this.app.fileManager.processFrontMatter(f, x => applyDateEdit(x, edit));
		const label = `“${f.basename}” → ${day.slice(5).replace('-', '月')}日`;
		dropUndo.stack.push({ label, at: edit.at, undo: async () => {
			const g = this.app.vault.getAbstractFileByPath(path);
			if (!(g instanceof TFile)) return false;
			let ok = false;
			await this.app.fileManager.processFrontMatter(g, x => { ok = undoDateEdit(x, edit); });
			return ok;
		} });
		if (dropUndo.stack.length > 20) dropUndo.stack.shift();
		dropUndo.fresh = true;
		const frag = createFragment(fr => {
			fr.createSpan({ text: `已把${label}${start ? '' : '（原来没有日期）'} ` });
			const u = fr.createEl('a', { cls: 'n-undo-link', text: '撤销', href: '#' });
			u.addEventListener('click', e => { e.preventDefault(); void undoLastDrop(); });
		});
		new Notice(frag, 8000);
	}

	/** folder the rows of this database live in (from the rows Bases gives us, else the base's folder filter) */
	private rowFolder(): string | null {
		const safe = (o: unknown) => { const seen = new WeakSet(); try { return JSON.stringify(o ?? null, (_k, v) => { if (v && typeof v === 'object') { if (seen.has(v)) return undefined; seen.add(v); } return v; }); } catch { return ''; } };
		const m = /file\.folder == \\?"([^"\\]+)\\?"/.exec(safe(this.ctl?.query?.filters));
		if (m) return m[1];
		for (const e of (this.data?.data || []) as any[]) if (e.file?.parent) return e.file.parent.path;
		return null;
	}

	private async newRow(key: string, day: string) {
		const folder = this.rowFolder();
		if (!folder) { new Notice('找不到这个数据库的行所在的文件夹'); return; }
		if (!this.app.vault.getAbstractFileByPath(normalizePath(folder))) await this.app.vault.createFolder(normalizePath(folder)).catch(() => null);
		const path = uniquePath(this.app, normalizePath(folder), UNTITLED, 'md');
		const f = await this.app.vault.create(path, `---\ncssclasses:\n  - notion\n${JSON.stringify(key)}: ${day}\n---\n`);
		const peek = calendarHooks.peek;
		if (peek) await peek(f, this.el.closest('.workspace-leaf')); else await this.app.workspace.getLeaf('tab').openFile(f);
	}
}

/** set by the plugin: open a row in Notion's side peek */
export const calendarHooks: { peek?: (f: TFile, from: Element | null) => Promise<void> } = {};

/** Notion form view: a small form that creates a new row note in the database's folder. */
class FormView extends NotionBasesView {
	type = 'notion-form';
	private drawn = '';
	protected render() {
		const c = this.config;
		const fields = (c.get('fields') as any[]) || [];
		const folder = String(c.get('folder') || '');
		const sig = JSON.stringify([fields, folder]);
		if (sig === this.drawn) return;   // keep what the user is typing when rows change
		this.drawn = sig;
		this.el.empty();
		const form = this.el.createEl('form', { cls: 'n-form' });
		form.createDiv({ cls: 'n-form-title', text: String(c.get('name') || (this as any).config?.name || '') });
		const inputs: { f: any; el: HTMLInputElement | HTMLSelectElement }[] = [];
		for (const f of fields) {
			const row = form.createDiv({ cls: 'n-form-field' });
			row.createEl('label', { text: f.name + (f.key === 'file.name' ? ' *' : '') });
			let el: HTMLInputElement | HTMLSelectElement;
			if (f.options?.length && f.type !== 'multi_select') {
				el = row.createEl('select', { cls: 'dropdown' });
				el.createEl('option', { text: '', value: '' });
				for (const o of f.options) el.createEl('option', { text: o, value: o });
			} else {
				el = row.createEl('input', { type: f.type === 'checkbox' ? 'checkbox' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text' });
				if (f.type === 'multi_select' && f.options?.length) el.placeholder = f.options.slice(0, 6).join(', ') + ' …（逗号分隔）';
			}
			inputs.push({ f, el });
		}
		const btn = form.createEl('button', { cls: 'mod-cta', text: '提交（新建一条）' });
		if (c.get('url')) { const a = form.createEl('a', { cls: 'n-form-link', text: '在 Notion 中打开此表单', href: String(c.get('url')) }); a.target = '_blank'; }
		form.addEventListener('submit', async ev => {
			ev.preventDefault();
			const title = (inputs.find(i => i.f.key === 'file.name')?.el.value || '').trim().replace(/[\\/:*?"<>|#^[\]]/g, ' ');
			if (!title) { new Notice('请先填写标题'); return; }
			const lines = ['---', 'cssclasses:', '  - notion'];
			for (const { f, el } of inputs) {
				if (f.key === 'file.name') continue;
				const v = f.type === 'checkbox' ? (el as HTMLInputElement).checked : el.value.trim();
				if (v === '' ) continue;
				if (f.type === 'multi_select') { lines.push(`${JSON.stringify(f.key)}:`, ...String(v).split(/[,，]/).map(x => x.trim()).filter(Boolean).map(x => `  - ${JSON.stringify(x)}`)); continue; }
				lines.push(`${JSON.stringify(f.key)}: ${typeof v === 'boolean' || f.type === 'number' ? v : JSON.stringify(v)}`);
			}
			lines.push('---', '');
			let path = normalizePath(`${folder}/${title}.md`); let n = 1;
			while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${title} (${++n}).md`);
			await this.app.vault.create(path, lines.join('\n'));
			new Notice('已新建：' + path.split('/').pop());
			for (const { el } of inputs) { if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = false; else el.value = ''; }
		});
	}
}

export function registerNotionBasesViews(plugin: Plugin): boolean {
	const reg = (plugin as any).registerBasesView?.bind(plugin);
	if (!reg) return false;   // Obsidian < 1.10
	reg('notion-chart', {
		name: 'Chart (Notion)', icon: 'lucide-bar-chart-3',
		factory: (ctl: QueryController, el: HTMLElement) => new ChartView(ctl, el),
		options: () => [
			{ type: 'dropdown', key: 'chartType', displayName: 'Chart type', default: 'column', options: { column: 'Column', donut: 'Donut', pie: 'Pie' } },
			{ type: 'property', key: 'x', displayName: 'Group by (x axis)' },
			{ type: 'dropdown', key: 'dateGroup', displayName: 'Date grouping', default: 'month', options: { year: 'Year', month: 'Month', week: 'Week', day: 'Day' } },
		],
	});
	reg('notion-calendar', {
		name: 'Calendar (Notion)', icon: 'lucide-calendar',
		factory: (ctl: QueryController, el: HTMLElement) => new CalendarView(ctl, el),
		options: () => [
			{ type: 'property', key: 'date', displayName: 'Date property' },
			{ type: 'dropdown', key: 'range', displayName: 'Show', default: 'month', options: { month: 'Month', week: 'Week' } },
		],
	});
	reg('notion-form', {
		name: 'Form (Notion)', icon: 'lucide-clipboard-list',
		factory: (ctl: QueryController, el: HTMLElement) => new FormView(ctl, el),
		options: () => [],
	});
	return true;
}
