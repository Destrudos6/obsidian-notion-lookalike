// Notion "@" mentions (EditorSuggest, public API; Notion mode only). Inserts the importer's own mention formats:
//   @page  → [[path|Title]]                        (like an imported page mention)
//   @date  → <span class="n-mention-date">@2026-11-08</span>   (like an imported date mention)
// "[[" stays Obsidian's own link suggest.
import { type App, type Editor, type EditorPosition, EditorSuggest, type EditorSuggestContext, type EditorSuggestTriggerInfo, Modal, TFile, prepareFuzzySearch, setIcon } from 'obsidian';
import type { NotionHost } from './host.ts';
import { isHiddenName } from './pages.ts';
import { emojifyText } from '../emoji.ts';
import { mentionTrigger, inBlockCode } from './trigger.ts';
import { ymdOf } from '../render/calendar-edit.ts';

interface Item { kind: 'date' | 'pick-date' | 'page'; label: string; date?: string; file?: TFile; hint?: string }

export const dateMention = (ymd: string) => `<span class="n-mention-date">@${ymd}</span>`;

class DateModal extends Modal {
	private done: (v: string | null) => void;
	constructor(app: App, done: (v: string | null) => void) { super(app); this.done = done; }
	onOpen() {
		this.titleEl.setText('选择日期');
		const i = this.contentEl.createEl('input', { type: 'date', cls: 'n-date-input' });
		i.value = ymdOf(new Date());
		const b = this.contentEl.createDiv({ cls: 'modal-button-container' }).createEl('button', { cls: 'mod-cta', text: '插入' });
		const ok = () => { const v = i.value; this.done(v || null); this.done = () => {}; this.close(); };
		b.onclick = ok;
		i.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
		window.setTimeout(() => i.focus(), 30);
	}
	onClose() { this.done(null); this.contentEl.empty(); }
}

export class MentionSuggest extends EditorSuggest<Item> {
	host: NotionHost;
	enabled: () => boolean;
	constructor(app: App, host: NotionHost, enabled: () => boolean) { super(app); this.host = host; this.enabled = enabled; this.limit = 30; }

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		if (!this.enabled()) return null;
		const line = editor.getLine(cursor.line).slice(0, cursor.ch);
		// "@" / "＠" anywhere (also right after CJK text), not in e-mail addresses, code, URLs, links
		const t = mentionTrigger(line);
		if (!t || inBlockCode(i => editor.getLine(i), cursor.line)) return null;
		const start = t.start;
		return { start: { line: cursor.line, ch: start }, end: cursor, query: t.query };
	}

	getSuggestions(ctx: EditorSuggestContext): Item[] {
		const q = ctx.query.trim();
		const today = new Date();
		const d = (n: number) => { const x = new Date(today); x.setDate(x.getDate() + n); return ymdOf(x); };
		const dates: Item[] = [
			{ kind: 'date', label: '今天', date: d(0), hint: 'today' }, { kind: 'date', label: '明天', date: d(1), hint: 'tomorrow' },
			{ kind: 'date', label: '昨天', date: d(-1), hint: 'yesterday' }, { kind: 'pick-date', label: '选择日期…', hint: 'date' },
		];
		const out: Item[] = q ? dates.filter(x => x.label.includes(q) || x.hint!.startsWith(q.toLowerCase()) || (x.date ?? '').startsWith(q)) : dates;
		if (/^\d{4}-\d{2}-\d{2}$/.test(q)) out.unshift({ kind: 'date', label: q, date: q });
		const files = this.app.vault.getFiles().filter(f => (f.extension === 'md' || f.extension === 'base') && !f.path.split('/').some(isHiddenName) && f !== ctx.file);
		if (!q) {
			const recent = this.app.workspace.getLastOpenFiles().map(p => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile && files.includes(f));
			for (const f of recent.slice(0, 8)) out.push({ kind: 'page', label: f.basename, file: f });
			return out;
		}
		const fz = prepareFuzzySearch(q);
		const hits = files.map(f => ({ f, m: fz(f.basename) })).filter(x => x.m).sort((a, b) => b.m!.score - a.m!.score || a.f.path.length - b.f.path.length);
		for (const h of hits.slice(0, 20)) out.push({ kind: 'page', label: h.f.basename, file: h.f });
		return out;
	}

	renderSuggestion(it: Item, el: HTMLElement) {
		el.addClass('n-mention-item');
		const ic = el.createDiv({ cls: 'n-mention-icon' });
		if (it.kind === 'page' && it.file) {
			const v = this.host.icons.iconFor(it.file.path);
			if (v) ic.appendChild(this.host.icons.makeIcon(v, it.file.path, 'is-search')); else setIcon(ic, it.file.extension === 'base' ? 'table-2' : 'file-text');
			el.createDiv({ cls: 'n-mention-title', text: it.label });
			const crumbs = this.host.model.ancestors(it.file).map(a => a.title).join(' / ');
			if (crumbs) el.createDiv({ cls: 'n-mention-path', text: crumbs });
		} else {
			setIcon(ic, 'calendar');
			el.createDiv({ cls: 'n-mention-title', text: it.label });
			if (it.date) el.createDiv({ cls: 'n-mention-path', text: it.date });
		}
		emojifyText(el);
	}

	selectSuggestion(it: Item) {
		const c = this.context; if (!c) return;
		const put = (s: string) => { c.editor.replaceRange(s + ' ', c.start, c.end); c.editor.setCursor({ line: c.start.line, ch: c.start.ch + s.length + 1 }); };
		if (it.kind === 'date' && it.date) put(dateMention(it.date));
		else if (it.kind === 'pick-date') new DateModal(this.app, v => { if (v) put(dateMention(v)); }).open();
		else if (it.file) put(`[[${it.file.extension === 'md' ? it.file.path.replace(/\.md$/, '') : it.file.path}|${it.file.basename.replace(/[|\]]/g, ' ')}]]`);
		this.close();
	}
}
