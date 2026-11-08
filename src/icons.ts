/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion-style page icons everywhere a page name appears:
//   file explorer (files + the folder that holds a page's sub-pages), tab titles, internal links in reading
//   view / Bases cells / properties / hover previews (DOM decoration), and wikilinks in Live Preview
//   (CodeMirror widget). Icons come from the `notion-icon` frontmatter key (emoji, [[image]] or URL) and,
//   for databases, from the `# notion-icon:` comment line at the top of the .base file.
// Everything is cached by path; the DOM work is batched to one animation frame.
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { type App, type CachedMetadata, editorInfoField, parseYaml, editorLivePreviewField, type Plugin, TFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import { emojiUrl, isEmoji, loadEmoji } from './emoji.ts';

const DONE = 'nIcon';                 // dataset key marking a decorated element (value = icon it got)
const ICON_CLS = 'n-page-icon';

export class IconManager {
	private app: App;
	private plugin: Plugin;
	/** vault path → raw icon value */
	private index = new Map<string, string | null>();   // null = known to have no icon
	/** "source\0linktext" → resolved path ('' = unresolved) */
	private resolveCache = new Map<string, string>();
	private pending = new Set<Element>();
	private full = false;
	private frame = 0;
	private observer: MutationObserver | null = null;
	enabled = true;
	/** bumped whenever an icon changes so editor widgets re-render */
	version = 0;

	private baseIcons: () => Record<string, string>;
	private saveBaseIcons: () => Promise<void>;
	constructor(app: App, plugin: Plugin, baseIcons: () => Record<string, string>, save: () => Promise<void>) {
		this.app = app; this.plugin = plugin; this.baseIcons = baseIcons; this.saveBaseIcons = save;
	}

	// ---------------------------------------------------------------- index
	load() {
		const { app, plugin } = this;
		const all = () => {
			for (const f of app.vault.getMarkdownFiles()) this.indexMd(f, app.metadataCache.getFileCache(f));
			for (const f of app.vault.getFiles()) if (f.extension === 'base') void this.indexBase(f);
		};
		all();
		// the metadata cache may still be building at load time: index again once it is resolved
		let first = true;
		plugin.registerEvent(app.metadataCache.on('resolved', () => { if (first) { first = false; all(); this.changed(); } }));
		plugin.registerEvent(app.metadataCache.on('changed', (f, _d, cache) => { if (this.indexMd(f, cache)) this.changed(); }));
		plugin.registerEvent(app.metadataCache.on('resolved', () => this.resolveCache.clear()));
		plugin.registerEvent(app.vault.on('modify', f => { if (f instanceof TFile && f.extension === 'base') void this.indexBase(f, true); }));
		plugin.registerEvent(app.vault.on('create', f => { if (f instanceof TFile && f.extension === 'base') void this.indexBase(f, true); }));
		plugin.registerEvent(app.vault.on('delete', f => { if (this.index.delete(f.path)) this.changed(); }));
		plugin.registerEvent(app.vault.on('rename', (f, old) => {
			const v = this.index.get(old);
			this.resolveCache.clear();
			if (v !== undefined) { this.index.delete(old); this.index.set(f.path, v); }
			const map = this.baseIcons();
			if (map[old] !== undefined) { map[f.path] = map[old]; delete map[old]; void this.saveBaseIcons(); }
			this.changed();
		}));
		plugin.registerEvent(app.workspace.on('layout-change', () => this.schedule(null, true)));
		plugin.registerEvent(app.workspace.on('file-open', () => this.schedule(null, true)));
		app.workspace.onLayoutReady(() => { this.observe(); this.schedule(null, true); });
		// emoji images: once the bundled Twemoji pack is decoded, redraw every icon as an image
		void loadEmoji().then(p => { if (p) { this.clearAll(); this.changed(); } });
	}

	private indexMd(f: TFile, cache: CachedMetadata | null): boolean {
		const fm = cache?.frontmatter;
		const v = fm?.['notion-icon'] ?? fm?.icon ?? fm?.['icon-image'];  // icon / icon-image: older imports
		if (!cache) return false;
		const s = v === undefined || v === null || v === '' ? null : String(Array.isArray(v) ? v[0] : v);
		if (this.index.get(f.path) === s) return false;
		const had = this.index.has(f.path);
		this.index.set(f.path, s);
		return had || s !== null;
	}

	/** called with the `notion:` block of every .base file (icon, colors, ids) */
	onBaseMeta?: (path: string, meta: BaseMeta | null) => void;

	private async indexBase(f: TFile, notify = false) {
		const text = await this.app.vault.cachedRead(f);
		const meta = baseMeta(text);
		this.onBaseMeta?.(f.path, meta);
		const m = text.slice(0, 600).match(/^# notion-icon: (.+)$/m);
		const map = this.baseIcons();
		// `notion: icon:` survives Obsidian rewriting the file; the comment line (older imports) does not
		const s = meta?.icon ?? (m ? m[1].trim() : map[f.path] ?? null);
		// remember it: Obsidian rewrites .base files when a view is edited and drops comment lines
		if (m && map[f.path] !== s) { map[f.path] = s!; void this.saveBaseIcons(); }
		if (this.index.get(f.path) === s) return;
		this.index.set(f.path, s);
		if (notify) this.changed(); else this.schedule(null, true);
	}

	/** called after any icon changed (page tree, breadcrumbs) */
	listeners = new Set<() => void>();
	private changed() { this.version++; this.schedule(null, true); this.app.workspace.updateOptions(); this.listeners.forEach(f => { try { f(); } catch { /* */ } }); }

	/** icon of a file, or of a folder that holds a page's sub-pages (`X/` next to `X.md`, or `X/X.base`) */
	iconFor(path: string): string | undefined {
		if (!this.index.has(path)) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFolder) return this.iconFor(path + '.md') ?? this.index.get(`${path}/${f.name}.base`) ?? undefined;
			if (f instanceof TFile && f.extension === 'md') this.indexMd(f, this.app.metadataCache.getFileCache(f));
		}
		return this.index.get(path) ?? undefined;
	}

	resolve(linktext: string, source: string): string {
		const key = source + '\0' + linktext;
		let r = this.resolveCache.get(key);
		if (r === undefined) {
			const clean = linktext.replace(/[#^].*$/, '');
			const f = clean ? this.app.metadataCache.getFirstLinkpathDest(clean, source) : null;
			r = f ? f.path : '';
			if (this.resolveCache.size > 5000) this.resolveCache.clear();
			this.resolveCache.set(key, r);
		}
		return r;
	}

	/** image URL for an icon value: vault image, web image or bundled emoji image (null = draw as text) */
	iconSrc(value: string, from: string): { src: string | null; emoji: boolean } {
		const m = value.match(/^\[\[([^|\]]+)/);
		if (m) { const f = this.app.metadataCache.getFirstLinkpathDest(m[1], from); return { src: f ? this.app.vault.getResourcePath(f) : emojiUrl('📄'), emoji: !f }; }
		if (/^https?:\/\//.test(value)) return { src: value, emoji: false };
		return { src: isEmoji(value) ? emojiUrl(value) : null, emoji: true };
	}

	/** <span>/<img> element for an icon value */
	makeIcon(value: string, from: string, extra = ''): HTMLElement {
		const { src, emoji } = this.iconSrc(value, from);
		const el = createSpan({ cls: `${ICON_CLS} ${extra}`.trim() });
		el.setAttr('aria-hidden', 'true');
		el.contentEditable = 'false';
		if (src) { el.addClass(emoji ? 'is-emoji' : 'is-image'); el.createEl('img', { attr: { src, alt: emoji ? value : '' } }); }
		else if (/^\[\[/.test(value)) el.setText('📄');
		else el.setText(value);
		return el;
	}

	// ---------------------------------------------------------------- DOM decoration
	private observe() {
		this.observer = new MutationObserver(recs => {
			for (const r of recs) {
				if (r.type === 'attributes') { if (r.target instanceof Element) this.pending.add(r.target); continue; }
				r.addedNodes.forEach(n => { if (n instanceof Element && !n.hasClass(ICON_CLS) && !n.closest('.n-popover, .n-tree-body')) this.pending.add(n); });
				// tab titles / explorer titles get their text replaced → re-check the parent
				if (r.target instanceof Element && !r.target.closest('.cm-content')) this.pending.add(r.target);
			}
			if (this.pending.size) this.schedule(null, false);
		});
		this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-href', 'data-path'] });
		this.plugin.register(() => this.observer?.disconnect());
	}

	schedule(el: Element | null, full: boolean) {
		if (el) this.pending.add(el);
		if (full) this.full = true;
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => { this.frame = 0; this.flush(); });
	}

	private flush() {
		const full = this.full; this.full = false;
		const roots = full ? [document.body] : [...this.pending];
		this.pending.clear();
		this.observer?.takeRecords();
		for (const root of roots) {
			if (!root.isConnected) continue;
			this.decorateLinks(root);
			this.decorateExplorer(root);
		}
		this.decorateTabs();
		this.observer?.takeRecords(); // our own insertions
	}

	private sourceOf(el: Element): string {
		const leafEl = el.closest('.workspace-leaf');
		let src = '';
		if (leafEl) this.app.workspace.iterateAllLeaves(l => { if (!src && (l as any).containerEl === leafEl) src = (l.view as any)?.file?.path || ''; });
		return src || this.app.workspace.getActiveFile()?.path || '';
	}

	private setIcon(host: HTMLElement, icon: string | undefined, from: string, place: (icon: HTMLElement) => void, extra = '') {
		const cur = host.dataset[DONE];
		if (cur === (icon ?? '') && (icon === undefined || host.querySelector(`:scope > .${ICON_CLS}, :scope > * > .${ICON_CLS}`))) return;
		host.querySelectorAll(`:scope > .${ICON_CLS}, :scope > * > .${ICON_CLS}`).forEach(e => e.remove());
		host.dataset[DONE] = icon ?? '';
		if (!this.enabled || icon === undefined) return;
		place(this.makeIcon(icon, from, extra));
	}

	private decorateLinks(root: Element) {
		const links: HTMLElement[] = [];
		if (root.matches?.('.internal-link[data-href]')) links.push(root as HTMLElement);
		root.querySelectorAll<HTMLElement>('.internal-link[data-href]').forEach(a => links.push(a));
		if (!links.length) return;
		let src: string | null = null;
		for (const a of links) {
			if (a.closest('.cm-content') && !a.closest('.cm-embed-block, .bases-embed, .internal-embed, .block-language-base')) continue;
			if (a.closest('.notion-header')) continue;
			src ??= this.sourceOf(a);
			const path = this.resolve(a.dataset.href || '', src);
			this.setIcon(a, path ? this.iconFor(path) : undefined, src, ic => a.prepend(ic), 'is-link');
		}
	}

	private decorateExplorer(root: Element) {
		const items: HTMLElement[] = [];
		if (root.matches?.('.nav-file-title[data-path], .nav-folder-title[data-path]')) items.push(root as HTMLElement);
		else {
			const t = root.closest?.('.nav-file-title[data-path], .nav-folder-title[data-path]');
			if (t) items.push(t as HTMLElement);
		}
		root.querySelectorAll<HTMLElement>('.nav-file-title[data-path], .nav-folder-title[data-path]').forEach(e => items.push(e));
		for (const it of items) {
			const inner = it.querySelector<HTMLElement>('.tree-item-inner');
			if (!inner) continue;
			const path = it.dataset.path || '';
			this.setIcon(inner, this.iconFor(path), path, ic => inner.prepend(ic), 'is-explorer');
		}
	}

	private decorateTabs() {
		this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			const t = (leaf as any).tabHeaderInnerTitleEl as HTMLElement | undefined;
			const file = (leaf.view as any)?.file as TFile | undefined;
			if (!t) return;
			const icon = file ? this.iconFor(file.path) : undefined;
			const has = t.querySelector(`.${ICON_CLS}`);
			if (t.dataset[DONE] === (icon ?? '') && (!icon || has)) return;
			has?.remove();
			t.dataset[DONE] = icon ?? '';
			if (this.enabled && icon && file) t.prepend(this.makeIcon(icon, file.path, 'is-tab'));
		});
	}

	clearAll() {
		document.querySelectorAll(`.${ICON_CLS}`).forEach(e => { if (!e.closest('.cm-content')) e.remove(); });
		document.querySelectorAll<HTMLElement>('[data-n-icon]').forEach(e => delete e.dataset[DONE]);
	}

	// ---------------------------------------------------------------- Live Preview wikilinks
	editorExtension() {
		const mgr = this;
		class IconWidget extends WidgetType {
			icon: string; from: string;
			v: number;
			constructor(icon: string, from: string) { super(); this.icon = icon; this.from = from; this.v = mgr.version; }
			eq(o: IconWidget) { return o.icon === this.icon && o.v === this.v; }
			toDOM() { return mgr.makeIcon(this.icon, this.from, 'is-link is-editor'); }
			ignoreEvent() { return false; }
		}
		const LINK = /(!?)\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
		function build(view: EditorView): DecorationSet {
			const b = new RangeSetBuilder<Decoration>();
			if (!mgr.enabled || !view.state.field(editorLivePreviewField, false)) return b.finish();
			const file = view.state.field(editorInfoField, false)?.file;
			const src = file?.path || '';
			let lastTo = 0; let lastPos = -1;
			for (const range of view.visibleRanges) {
				let from = range.from; const to = range.to;
				if (from < lastTo) from = lastTo;
				if (from >= to) continue;
				const doc = view.state.doc;
				const startLine = doc.lineAt(from);
				const text = doc.sliceString(startLine.from, to);
				let fence = false;
				// fence state at the top of the viewport (scan from the start; only fence lines matter)
				for (const it = doc.iterLines(1, startLine.number); !it.next().done;) if (/^\s*(```|~~~)/.test(it.value)) fence = !fence;
				from = startLine.from;
				let offset = 0;
				for (const line of text.split('\n')) {
					if (/^\s*(```|~~~)/.test(line)) fence = !fence;
					else if (!fence) {
						LINK.lastIndex = 0;
						let m: RegExpExecArray | null;
						while ((m = LINK.exec(line))) {
							if (m[1]) continue; // embed
							const path = mgr.resolve(m[2], src);
							const icon = path ? mgr.iconFor(path) : undefined;
							if (icon === undefined) continue;
							const pos = from + offset + m.index;
							if (pos <= lastPos) continue;
							lastPos = pos;
							b.add(pos, pos, Decoration.widget({ widget: new IconWidget(icon, src), side: -1 }));
						}
					}
					offset += line.length + 1;
				}
				lastTo = to;
			}
			return b.finish();
		}
		return ViewPlugin.fromClass(class {
			decorations: DecorationSet; v: number;
			constructor(view: EditorView) { this.decorations = build(view); this.v = mgr.version; }
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || this.v !== mgr.version || u.transactions.some(t => t.reconfigured)) {
					this.decorations = build(u.view); this.v = mgr.version;
				}
			}
		}, { decorations: v => v.decorations });
	}
}

export interface BaseMeta { icon?: string; colors?: Record<string, Record<string, string>>; database?: string; status?: string[] }

/** The `notion:` top-level block the importer writes into .base files (Bases keeps unknown top-level keys). */
export function baseMeta(text: string): BaseMeta | null {
	const m = text.match(/^notion:[ \t]*\n((?:[ \t]+.*(?:\n|$)|[ \t]*\n)*)/m);
	if (!m) return null;
	try {
		const doc = parseYaml('notion:\n' + m[1]) as { notion?: BaseMeta };
		const n = doc?.notion;
		if (!n || typeof n !== 'object') return null;
		return { icon: n.icon ? String(n.icon) : undefined, colors: n.colors, database: n.database ? String(n.database) : undefined, status: Array.isArray(n.status) ? n.status.map(String) : undefined };
	} catch { return null; }
}
