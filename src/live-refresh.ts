/* eslint-disable @typescript-eslint/no-explicit-any */
// Bases caches each note's formula results and only re-evaluates a note when THAT note changes. Imported
// Notion rollups read other notes (list(note.Tasks).map(value.asFile().properties["Done"])), so when a
// linked note changes, the notes that link to it in their frontmatter (= Notion relations) must be
// re-evaluated too. Verified in Obsidian 1.15: re-opening the base does not help, but a `changed`
// metadata event for the dependent note does. We re-emit `changed` (same file, same content) for the
// one-hop frontmatter backlinks of every changed note, debounced and loop-safe.
import { type App, type Plugin, TFile } from 'obsidian';

export class LiveRefresh {
	private app: App;
	private plugin: Plugin;
	private reverse: Map<string, Set<string>> | null = null;   // dest path → sources linking to it in frontmatter
	private queue = new Set<string>();
	private synthetic = new Set<string>();
	private timer = 0;
	enabled = true;

	constructor(app: App, plugin: Plugin) { this.app = app; this.plugin = plugin; }

	load() {
		const { app, plugin } = this;
		plugin.registerEvent(app.metadataCache.on('changed', f => {
			if (this.synthetic.delete(f.path)) return;   // our own re-emit
			this.reverse = null;
			this.enqueue(f.path);
		}));
		plugin.registerEvent(app.vault.on('delete', f => { this.enqueue(f.path); }));
		plugin.registerEvent(app.vault.on('rename', (_f, old) => { this.enqueue(old); this.reverse = null; }));
		plugin.registerEvent(app.metadataCache.on('resolved', () => { this.reverse = null; }));
	}

	private enqueue(path: string) {
		if (!this.enabled) return;
		this.queue.add(path);
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.flush(), 250);
	}

	private index(): Map<string, Set<string>> {
		if (this.reverse) return this.reverse;
		const rev = new Map<string, Set<string>>();
		const mc = this.app.metadataCache;
		for (const f of this.app.vault.getMarkdownFiles()) {
			const links = mc.getFileCache(f)?.frontmatterLinks;
			if (!links?.length) continue;
			for (const l of links) {
				const dest = mc.getFirstLinkpathDest(l.link.replace(/[#^].*$/, ''), f.path);
				if (!dest) continue;
				let s = rev.get(dest.path); if (!s) rev.set(dest.path, s = new Set()); s.add(f.path);
			}
		}
		return (this.reverse = rev);
	}

	private flush() {
		const changed = [...this.queue]; this.queue.clear();
		const rev = this.index();
		const targets = new Set<string>();
		for (const p of changed) rev.get(p)?.forEach(s => { if (!changed.includes(s)) targets.add(s); });
		for (const p of targets) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (!(f instanceof TFile)) continue;
			const cache = this.app.metadataCache.getFileCache(f);
			if (!cache) continue;
			this.synthetic.add(p);
			void this.app.vault.cachedRead(f).then(data => this.app.metadataCache.trigger('changed', f, data, cache));
		}
	}
}
