// Notion-style search (Ctrl+P in Notion mode): pages and databases with their icons and the page path,
// recent pages when the query is empty. Also used as the page picker for "Move to…" and "/link to page".
import { type App, SuggestModal, TFile, prepareFuzzySearch, setIcon, type SearchResult } from 'obsidian';
import type { NotionHost } from './host.ts';
import { isHiddenName, type PageNode } from './pages.ts';
import { emojifyText } from '../emoji.ts';

interface Hit { node: PageNode | null; path: string; match: SearchResult | null; create?: string }

export class PageSearchModal extends SuggestModal<Hit> {
	host: NotionHost;
	private onPick: ((n: PageNode | null, newTab: boolean) => void) | null;
	private exclude: PageNode | null;
	private allowTop: boolean;
	constructor(app: App, host: NotionHost, opts: { title?: string; onPick?: (n: PageNode | null, newTab: boolean) => void; exclude?: PageNode | null; allowTop?: boolean } = {}) {
		super(app);
		this.host = host;
		this.onPick = opts.onPick ?? null;
		this.exclude = opts.exclude ?? null;
		this.allowTop = !!opts.allowTop;
		this.modalEl.addClass('n-search-modal');
		this.setPlaceholder(opts.title ?? '搜索页面…');
		this.limit = 60;
		this.setInstructions([{ command: '↑↓', purpose: '选择' }, { command: '↵', purpose: '打开' }, { command: 'Ctrl+↵', purpose: '新标签页打开' }, { command: 'Esc', purpose: '关闭' }]);
		this.scope.register(['Mod'], 'Enter', ev => { (this as unknown as { chooser: { useSelectedItem(e: KeyboardEvent): void } }).chooser?.useSelectedItem?.(ev); return false; });
	}

	private pages(): TFile[] {
		return this.app.vault.getFiles().filter(f => (f.extension === 'md' || f.extension === 'base') && !f.path.split('/').some(isHiddenName));
	}

	getSuggestions(q: string): Hit[] {
		const model = this.host.model;
		const ex = this.exclude?.folder?.path;
		const ok = (f: TFile) => !(this.exclude && (f.path === this.exclude.key || (ex && f.path.startsWith(ex + '/'))));
		const out: Hit[] = [];
		if (this.allowTop && !q.trim()) out.push({ node: null, path: '', match: null });
		if (!q.trim()) {
			const recent = this.app.workspace.getLastOpenFiles().map(p => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile && /^(md|base)$/.test(f.extension) && ok(f));
			for (const f of recent.slice(0, 12)) { const n = model.nodeForFile(f); if (n) out.push({ node: n, path: f.path, match: null }); }
			if (out.length < 8) for (const f of this.pages().slice(0, 30)) if (ok(f) && !out.some(h => h.path === f.path)) { const n = model.nodeForFile(f); if (n) out.push({ node: n, path: f.path, match: null }); }
			return out;
		}
		const fz = prepareFuzzySearch(q.trim());
		const scored: Hit[] = [];
		for (const f of this.pages()) {
			if (!ok(f)) continue;
			const m = fz(f.basename) ?? (() => { const r = fz(f.path); return r ? { ...r, score: r.score - 2 } : null; })();
			if (!m) continue;
			const n = model.nodeForFile(f);
			if (n) scored.push({ node: n, path: f.path, match: m });
		}
		scored.sort((a, b) => (b.match!.score - a.match!.score) || a.path.length - b.path.length);
		if (!this.onPick) scored.push({ node: null, path: '', match: null, create: q.trim() });
		return scored;
	}

	renderSuggestion(h: Hit, el: HTMLElement) {
		el.addClass('n-search-item');
		const ic = el.createDiv({ cls: 'n-search-icon' });
		if (h.create) { setIcon(ic, 'plus'); el.createDiv({ cls: 'n-search-title', text: `新建页面“${h.create}”` }); return; }
		if (!h.node) { setIcon(ic, 'home'); el.createDiv({ cls: 'n-search-title', text: '顶层（私人）' }); return; }
		const v = this.host.icons.iconFor(h.path);
		if (v) ic.appendChild(this.host.icons.makeIcon(v, h.path, 'is-search'));
		else setIcon(ic, h.node.kind === 'database' ? 'table-2' : 'file-text');
		const t = el.createDiv({ cls: 'n-search-text' });
		t.createDiv({ cls: 'n-search-title', text: h.node.title });
		const crumbs = this.host.model.ancestors(h.node.file!).map(a => a.title);
		if (crumbs.length) t.createDiv({ cls: 'n-search-path', text: crumbs.join(' / ') });
		emojifyText(el);
	}

	async onChooseSuggestion(h: Hit, ev: MouseEvent | KeyboardEvent) {
		const newTab = !!(ev && (ev.ctrlKey || ev.metaKey));
		if (this.onPick) { this.onPick(h.node, newTab); return; }
		if (h.create) {
			const f = await this.host.newPage(null);
			if (f) await this.app.fileManager.renameFile(f, (f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '') + h.create.replace(/[\\/:*?"<>|#^[\]]/g, ' ') + '.md');
			return;
		}
		if (h.node?.file) await this.host.openFile(h.node.file, newTab);
	}
}
