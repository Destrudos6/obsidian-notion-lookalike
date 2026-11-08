/* eslint-disable @typescript-eslint/no-explicit-any */
// Round 8.1: one place that knows "which database row is being dragged" — used by the page tree (row → page)
// and by the Notion calendar (row → day). Mouse = HTML5 drag events; finger / pen = pointer events with a
// long press (like the block handles), with a small ghost following the finger.
import { type App, Notice, type Plugin, TFile } from 'obsidian';

/** a row of a Bases table (title cell), board card, gallery card, list item; our calendar items and 无日期 items */
export const ROW_SELECTOR = '.bases-td[data-property="file.name"], .bases-kanban-card, .bases-cards-item, .bases-list-item, .n-cal-item[data-path], .n-nodate-item[data-path]';

/** The row note an element of a database view stands for (null = not a row). */
export function rowFileFromElement(app: App, t: Element | null): TFile | null {
	const cell = t?.closest?.(ROW_SELECTOR) as HTMLElement | null;
	if (!cell) return null;
	const direct = cell.dataset.path;
	if (direct) { const f = app.vault.getAbstractFileByPath(direct); return f instanceof TFile && f.extension === 'md' ? f : null; }
	const href = (cell.querySelector<HTMLElement>('.internal-link') ?? (t?.closest?.('.internal-link') as HTMLElement | null))?.dataset.href;
	const f = href ? app.metadataCache.getFirstLinkpathDest(href, '') : null;
	return f instanceof TFile && f.extension === 'md' ? f : null;
}

/** the row being dragged right now (mouse drag), shared by every calendar on screen */
export const rowDrag: { file: TFile | null } = { file: null };

/** a drop target (a calendar view) for finger drags */
export interface RowDropTarget {
	el: HTMLElement;
	accepts(f: TFile): boolean;
	drop(f: TFile, day: string): Promise<void>;
}
export const dropTargets = new Set<RowDropTarget>();

/** undo of the last drops (most recent last); `fresh` = no other key was pressed since, so Ctrl+Z belongs to us */
export const dropUndo: { stack: { label: string; undo: () => Promise<boolean>; at: number }[]; fresh: boolean } = { stack: [], fresh: false };

export function installRowDrag(plugin: Plugin) {
	const app = plugin.app;
	plugin.registerDomEvent(document, 'dragstart', ev => {
		const f = rowFileFromElement(app, ev.target as Element);
		rowDrag.file = f ?? (((app as any).dragManager?.draggable?.file instanceof TFile) ? (app as any).dragManager.draggable.file : null);
	}, { capture: true });
	plugin.registerDomEvent(document, 'dragend', () => { window.setTimeout(() => { rowDrag.file = null; }, 50); }, { capture: true });

	// Ctrl/Cmd+Z right after a drop (no other key pressed in between) undoes the drop: Obsidian's own undo only
	// knows the open editor's text, not a property written into another note by a view.
	plugin.registerDomEvent(document, 'keydown', ev => {
		if (['Control', 'Meta', 'Shift', 'Alt'].includes(ev.key)) return;
		const z = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'z';
		if (z && dropUndo.fresh && dropUndo.stack.length && Date.now() - dropUndo.stack[dropUndo.stack.length - 1].at < 120000) {
			ev.preventDefault(); ev.stopPropagation();
			void undoLastDrop();
			return;
		}
		dropUndo.fresh = false;
	}, { capture: true });
	plugin.addCommand({ id: 'notion-undo-drop', name: '撤销上一次拖到日历 / Undo last calendar drop', callback: () => void undoLastDrop() });

	// finger / pen: long press on a row → drag → release over a calendar day
	plugin.registerDomEvent(document, 'pointerdown', ev => {
		if (ev.pointerType === 'mouse' || !dropTargets.size) return;
		const src = (ev.target as Element)?.closest?.(ROW_SELECTOR) as HTMLElement | null;
		if (!src || (ev.target as Element).closest('.n-cal-resize')) return;
		const f = rowFileFromElement(app, src);
		if (!f || ![...dropTargets].some(t => t.accepts(f))) return;
		const x0 = ev.clientX, y0 = ev.clientY;
		let ghost: HTMLElement | null = null; let over: HTMLElement | null = null;
		const timer = window.setTimeout(() => {
			ghost = document.body.createDiv({ cls: 'n-row-ghost', text: f.basename });
			ghost.style.left = `${x0 + 8}px`; ghost.style.top = `${y0 + 8}px`;
			src.addClass('is-dragging');
		}, 350);
		const targetAt = (x: number, y: number) => {
			const cell = (document.elementFromPoint(x, y) as Element | null)?.closest?.('.n-cal-cell[data-date]') as HTMLElement | null;
			if (!cell) return null;
			const t = [...dropTargets].find(d => d.el.contains(cell));
			return t && t.accepts(f) ? { t, cell } : null;
		};
		const move = (e: PointerEvent) => {
			if (e.pointerId !== ev.pointerId) return;
			if (!ghost) { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cleanup(); return; }   // moved before the long press = scroll
			e.preventDefault();
			ghost.style.left = `${e.clientX + 8}px`; ghost.style.top = `${e.clientY + 8}px`;
			const hit = targetAt(e.clientX, e.clientY);
			if (over && over !== hit?.cell) over.removeClass('is-drop');
			over = hit?.cell ?? null; over?.addClass('is-drop');
		};
		const up = (e: PointerEvent) => {
			if (e.pointerId !== ev.pointerId) return;
			const hit = ghost ? targetAt(e.clientX, e.clientY) : null;
			if (ghost) { e.preventDefault(); e.stopPropagation(); }
			cleanup();
			if (hit) void hit.t.drop(f, hit.cell.dataset.date!);
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cleanup, true);
			(ghost as HTMLElement | null)?.remove(); ghost = null; src.removeClass('is-dragging'); over?.removeClass('is-drop');
		};
		window.addEventListener('pointermove', move, { capture: true, passive: false });
		window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cleanup, true);
	}, { capture: true });
}

export async function undoLastDrop(): Promise<void> {
	const last = dropUndo.stack.pop();
	dropUndo.fresh = false;
	if (!last) { new Notice('没有可以撤销的拖放'); return; }
	new Notice(await last.undo() ? `已撤销：${last.label}` : `没有撤销：“${last.label}”之后这条的日期又被改过`);
}
