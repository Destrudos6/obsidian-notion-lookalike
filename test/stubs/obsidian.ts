// Minimal runtime stand-in for the `obsidian` module (types only on npm) — enough for src/notion/pages.ts.
export class TAbstractFile { path = ''; name = ''; parent: TFolder | null = null; }
export class TFile extends TAbstractFile { basename = ''; extension = ''; }
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; isRoot() { return this.path === '/'; } }
export class Notice { msg: string; constructor(msg: string) { this.msg = msg; Notice.last = msg; } static last = ''; }
export const normalizePath = (p: string) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';

/** in-memory vault from a list of paths ("a/b.md", "a/b/" = folder) */
export function fakeApp(paths: string[], links: Record<string, string[]> = {}) {
	const root = new TFolder(); root.path = '/'; root.name = '';
	const all = new Map<string, TAbstractFile>([['/', root]]);
	const folder = (p: string): TFolder => {
		if (!p) return root;
		let f = all.get(p) as TFolder | undefined;
		if (f) return f;
		f = new TFolder(); f.path = p; f.name = p.split('/').pop()!;
		const parent = folder(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
		f.parent = parent; parent.children.push(f); all.set(p, f);
		return f;
	};
	for (const p of paths) {
		if (p.endsWith('/')) { folder(p.slice(0, -1)); continue; }
		const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
		const f = new TFile(); f.path = p; f.name = p.split('/').pop()!; f.extension = f.name.split('.').pop()!; f.basename = f.name.slice(0, -(f.extension.length + 1));
		const parent = folder(dir); f.parent = parent; parent.children.push(f); all.set(p, f);
	}
	const byName = (link: string) => [...all.values()].find(f => f instanceof TFile && (f.path === link || f.path === link + '.md' || (f as TFile).basename === link)) as TFile | undefined;
	return {
		vault: { getRoot: () => root, getAbstractFileByPath: (p: string) => all.get(normalizePath(p)) ?? null },
		metadataCache: {
			getFileCache: (f: TFile) => ({ links: (links[f.path] || []).map((l, i) => ({ link: l, position: { start: { offset: i * 10 } } })), embeds: [] }),
			getFirstLinkpathDest: (l: string) => byName(l) ?? null,
		},
	};
}
// round 8: enough for slash.ts / mention.ts / compat imports
export class EditorSuggest<T> { app: any; context: any = null; limit = 0; constructor(app: any) { this.app = app; } setInstructions(_: any) {} close() {} declare _t?: T; }
export class Modal { app: any; contentEl: any = {}; titleEl: any = {}; modalEl: any = {}; constructor(app: any) { this.app = app; } open() {} close() {} }
export class MenuItem { setTitle() { return this; } }
export const setIcon = () => {};
export const prepareFuzzySearch = (q: string) => (s: string) => (s.toLowerCase().includes(q.toLowerCase()) ? { score: 1 } : null);
export class SuggestModal<T> extends Modal { declare _t?: T; setPlaceholder() {} setInstructions() {} }
export class FuzzySuggestModal<T> extends SuggestModal<T> {}
export class Menu { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() {} showAtPosition() {} }
export const Platform = { isMobile: false };
export const editorInfoField = {};
