/* eslint-disable @typescript-eslint/no-explicit-any */
// Table cell editing for what Bases cannot edit natively. Obsidian 1.15 Bases tables already edit text, number,
// checkbox, date (picker) and list properties in place; the importer's select / status / multi-select columns,
// however, are coloured `pill_*` formulas (read-only). Clicking such a cell opens a Notion-like dropdown (search,
// coloured options, create, clear) that writes the underlying note property. Local only.
import { type App, TFile } from 'obsidian';

export interface PillSpec { prop: string; multi: boolean; options: { name: string; color: string }[] }

/** read property, kind and option colours back from the importer's pill formula (src/core/views.ts pillFormula) */
export function parsePillFormula(expr: string): PillSpec | null {
	const m = /note\["((?:[^"\\]|\\.)*)"\]/.exec(expr);
	if (!m) return null;
	let prop: string;
	try { prop = JSON.parse(`"${m[1]}"`); } catch { prop = m[1]; }
	const multi = /^if\(note\["(?:[^"\\]|\\.)*"\], html\(list\(/.test(expr);
	const options: { name: string; color: string }[] = [];
	const re = /== "((?:[^"\\]|\\.)*)", "([a-z_]+)"/g;
	for (let x; (x = re.exec(expr));) {
		let n: string; try { n = JSON.parse(`"${x[1]}"`); } catch { n = x[1]; }
		if (!options.some(o => o.name === n)) options.push({ name: n, color: x[2] });
	}
	return { prop, multi, options };
}

export class PillCellEditor {
	app: App;
	private controllerOf: (el: Element) => any;
	private pop: HTMLElement | null = null;
	constructor(app: App, controllerOf: (el: Element) => any) { this.app = app; this.controllerOf = controllerOf; }

	/** capture-phase click handler (registered by the plugin) */
	onClick(ev: MouseEvent): boolean {
		const t = ev.target as HTMLElement | null;
		if (this.pop && t && this.pop.contains(t)) return false;
		this.close();
		const td = t?.closest<HTMLElement>('.bases-td[data-property^="formula.pill_"]');
		if (!td || ev.button !== 0) return false;
		const ctl = this.controllerOf(td);
		const expr = ctl?.query?.formulas?.[td.dataset.property!.slice('formula.'.length)];
		const text = typeof expr === 'string' ? expr : typeof expr?.text === 'string' ? expr.text : expr ? String(expr) : '';   // Bases keeps {text, formula}
		const spec = text ? parsePillFormula(text) : null;
		const file = this.rowFile(td);
		if (!spec || !file) return false;
		ev.preventDefault(); ev.stopPropagation();
		this.open(td, file, spec);
		return true;
	}

	private rowFile(td: HTMLElement): TFile | null {
		const href = td.closest('.bases-tr')?.querySelector<HTMLElement>('.bases-td[data-property="file.name"] .internal-link')?.dataset.href;
		if (!href) return null;
		const f = this.app.vault.getAbstractFileByPath(href) ?? this.app.metadataCache.getFirstLinkpathDest(href, '');
		return f instanceof TFile ? f : null;
	}

	close() { this.pop?.remove(); this.pop = null; }

	private current(file: TFile, spec: PillSpec): string[] {
		const v = this.app.metadataCache.getFileCache(file)?.frontmatter?.[spec.prop];
		return (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]).map(String);
	}

	private async write(file: TFile, spec: PillSpec, vals: string[]) {
		await this.app.fileManager.processFrontMatter(file, fm => { fm[spec.prop] = spec.multi ? vals : (vals[0] ?? null); });
	}

	private open(td: HTMLElement, file: TFile, spec: PillSpec) {
		const r = td.getBoundingClientRect();
		const pop = this.pop = document.body.createDiv({ cls: 'n-pill-pop notion' });
		pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`;
		pop.style.top = `${Math.min(r.top, window.innerHeight - 340)}px`;
		pop.style.minWidth = `${Math.max(240, r.width)}px`;
		const head = pop.createDiv({ cls: 'n-pill-pop-head' });
		const input = pop.createEl('input', { cls: 'n-pill-pop-input', attr: { placeholder: spec.multi ? '搜索或创建选项（可多选）' : '搜索或创建选项' } });
		const hint = pop.createDiv({ cls: 'n-pill-pop-hint', text: '选择一个选项或创建一个' });
		const list = pop.createDiv({ cls: 'n-pill-pop-list' });
		let vals = this.current(file, spec);
		const pill = (parent: HTMLElement, name: string, color: string, x = false) => {
			const p = parent.createSpan({ cls: `n-pill n-pill-${color || 'default'}`, text: name });
			if (x) { const b = p.createSpan({ cls: 'n-pill-x', text: '×' }); b.onclick = async e => { e.stopPropagation(); vals = vals.filter(v => v !== name); await this.write(file, spec, vals); draw(); }; }
			return p;
		};
		const colorOf = (n: string) => spec.options.find(o => o.name === n)?.color ?? 'default';
		const pick = async (name: string) => {
			if (spec.multi) vals = vals.includes(name) ? vals.filter(v => v !== name) : [...vals, name];
			else vals = vals[0] === name ? [] : [name];
			await this.write(file, spec, vals);
			if (!spec.multi) { this.close(); return; }
			input.value = ''; draw();
		};
		const draw = () => {
			head.empty();
			for (const v of vals) pill(head, v, colorOf(v), true);
			list.empty();
			const q = input.value.trim().toLowerCase();
			const opts = spec.options.filter(o => !q || o.name.toLowerCase().includes(q));
			for (const o of opts) {
				const row = list.createDiv({ cls: 'n-pill-pop-row' + (vals.includes(o.name) ? ' is-selected' : '') });
				pill(row, o.name, o.color);
				if (vals.includes(o.name)) row.createSpan({ cls: 'n-pill-pop-check', text: '✓' });
				row.onclick = () => void pick(o.name);
			}
			if (q && !spec.options.some(o => o.name.toLowerCase() === q)) {
				const row = list.createDiv({ cls: 'n-pill-pop-row is-create' });
				row.createSpan({ text: '创建 ' }); pill(row, input.value.trim(), 'default');
				row.onclick = () => { spec.options.push({ name: input.value.trim(), color: 'default' }); void pick(input.value.trim()); };
			}
			hint.toggle(!vals.length && !q);
		};
		input.addEventListener('input', draw);
		input.addEventListener('keydown', e => {
			if (e.key === 'Escape') { this.close(); return; }
			if (e.key === 'Enter') { (list.querySelector<HTMLElement>('.n-pill-pop-row:not(.is-selected)') ?? list.querySelector<HTMLElement>('.n-pill-pop-row'))?.click(); }
			if (e.key === 'Backspace' && !input.value && vals.length && spec.multi) { vals = vals.slice(0, -1); void this.write(file, spec, vals).then(draw); }
		});
		draw();
		window.setTimeout(() => input.focus(), 20);
	}
}
