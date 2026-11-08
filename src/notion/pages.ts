/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion mode – the page model on top of plain files (nothing here changes the file format):
//   page            = a .md note
//   sub-pages of P  = notes in the folder next to it with the same name (P.md + P/), the importer's layout
//   database        = a .base file; X/X.base (folder holding its rows) or any other .base
//   folder-only     = a folder with no same-name note (shown as a plain group, e.g. the import target folder)
// Every change goes through the public Vault / FileManager APIs (renameFile keeps links, trashFile respects the
// user's trash setting), so no content is ever rewritten except links/filters that point at a moved path.
import { type App, Notice, TFile, TFolder, normalizePath, type TAbstractFile } from 'obsidian';
import { UNTITLED, uniqueName } from '../core/naming.ts';

export type NodeKind = 'page' | 'database' | 'folder';
export interface PageNode {
	key: string;                 // stable id: file path (page / database) or folder path (folder-only)
	kind: NodeKind;
	file: TFile | null;          // the note / .base (null for folder-only)
	folder: TFolder | null;      // folder holding the sub-pages / rows
	title: string;
	parentKey: string;           // folder path the node lives in (its siblings share it)
}

/** bookkeeping folders/files of the importer and Obsidian that are not pages */
export const HIDDEN_NAMES = new Set(['_raw', '_attachments', '_导入报告.md', '_import-report.md', '_本地修改备份', '_已在Notion删除', '.trash', '.obsidian']);

export function isHiddenName(name: string): boolean {
	return HIDDEN_NAMES.has(name) || name.startsWith('.');
}

const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' });
export const byTitle = (a: PageNode, b: PageNode) => collator.compare(a.title, b.title);

export class PageModel {
	app: App;
	/** folder that is "transparent" at the top level (the import target, e.g. "Notion") */
	flatten: () => string;
	constructor(app: App, flatten: () => string) { this.app = app; this.flatten = flatten; }

	private folderHasPages(f: TFolder, depth = 0): boolean {
		if (depth > 8) return false;
		for (const c of f.children) {
			if (isHiddenName(c.name)) continue;
			if (c instanceof TFile && (c.extension === 'md' || c.extension === 'base')) return true;
			if (c instanceof TFolder && this.folderHasPages(c, depth + 1)) return true;
		}
		return false;
	}

	/** The database a folder stands for: X/X.base */
	dbOfFolder(f: TFolder): TFile | null {
		const b = f.children.find(c => c instanceof TFile && c.extension === 'base' && c.basename === f.name);
		return (b as TFile) ?? null;
	}

	/** Sub-page folder of a page note: P.md → P/ (sibling) */
	folderOf(file: TFile): TFolder | null {
		if (file.extension === 'base') {
			const p = file.parent;
			return p && p.name === file.basename ? p : null;
		}
		const p = this.app.vault.getAbstractFileByPath(normalizePath((file.parent?.path === '/' ? '' : file.parent!.path + '/') + file.basename));
		return p instanceof TFolder ? p : null;
	}

	nodeForFile(file: TFile): PageNode | null {
		if (file.extension !== 'md' && file.extension !== 'base') return null;
		const isDb = file.extension === 'base';
		const folder = this.folderOf(file);
		const parent = isDb && folder ? folder.parent : file.parent;
		return { key: file.path, kind: isDb ? 'database' : 'page', file, folder, title: file.basename, parentKey: parent?.path ?? '/' };
	}

	/** Children shown under a node (or under the root when `node` is null). */
	children(node: PageNode | null): PageNode[] {
		if (node?.kind === 'database') return [];   // rows are not listed in Notion's sidebar
		let folder: TFolder | null = node ? node.folder : this.app.vault.getRoot();
		if (!folder) return [];
		const out: PageNode[] = [];
		const add = (f: TFolder) => {
			const names = new Set(f.children.map(c => c.name));
			for (const c of f.children) {
				if (isHiddenName(c.name)) continue;
				if (c instanceof TFile) {
					if (c.extension === 'md') {
						const sub = names.has(c.basename) ? f.children.find(x => x instanceof TFolder && x.name === c.basename) as TFolder : null;
						out.push({ key: c.path, kind: 'page', file: c, folder: sub ?? null, title: c.basename, parentKey: f.path });
					} else if (c.extension === 'base') {
						if (c.basename === f.name && f !== this.app.vault.getRoot()) continue;   // the folder's own database
						out.push({ key: c.path, kind: 'database', file: c, folder: null, title: c.basename, parentKey: f.path });
					}
				} else if (c instanceof TFolder) {
					if (names.has(c.name + '.md')) continue;        // merged into its note (folder note)
					if (c.name === 'Templates' && this.dbOfFolder(f)) continue;  // database templates
					const db = this.dbOfFolder(c);
					if (db) { out.push({ key: db.path, kind: 'database', file: db, folder: c, title: db.basename, parentKey: f.path }); continue; }
					if (!this.folderHasPages(c)) continue;          // attachment folders etc.
					if (!node && c.path === this.flatten()) { add(c); continue; }   // import target: lift its pages to the top
					out.push({ key: c.path, kind: 'folder', file: null, folder: c, title: c.name, parentKey: f.path });
				}
			}
		};
		add(folder);
		return out;
	}

	/** Parent chain (outermost first) for the breadcrumb: folder notes, databases and folder groups. */
	ancestors(file: TFile): PageNode[] {
		const out: PageNode[] = [];
		let folder: TFolder | null = file.parent;
		if (file.extension === 'base' && folder?.name === file.basename) folder = folder.parent;
		while (folder && folder.path !== '/' && folder.path !== '') {
			const parent: TFolder | null = folder.parent;
			const pre = parent && parent.path !== '/' ? parent.path + '/' : '';
			const note = this.app.vault.getAbstractFileByPath(pre + folder.name + '.md');
			const db = this.dbOfFolder(folder);
			if (note instanceof TFile) out.unshift({ key: note.path, kind: 'page', file: note, folder, title: note.basename, parentKey: parent?.path ?? '/' });
			else if (db && db !== file) out.unshift({ key: db.path, kind: 'database', file: db, folder, title: db.basename, parentKey: parent?.path ?? '/' });
			else if (folder.path !== this.flatten() && !(db && db === file)) out.unshift({ key: folder.path, kind: 'folder', file: null, folder, title: folder.name, parentKey: parent?.path ?? '/' });
			folder = parent;
		}
		return out;
	}

	/** Default order of the children: as linked in the parent note (Notion's block order), then by title. */
	defaultOrder(parent: PageNode | null, kids: PageNode[]): PageNode[] {
		const pos = new Map<string, number>();
		const f = parent?.file;
		if (f && f.extension === 'md') {
			const cache = this.app.metadataCache.getFileCache(f);
			const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].sort((a, b) => a.position.start.offset - b.position.start.offset);
			for (const r of refs) {
				const t = this.app.metadataCache.getFirstLinkpathDest(r.link.replace(/[#^].*$/, ''), f.path);
				if (t && !pos.has(t.path)) pos.set(t.path, r.position.start.offset);
			}
		}
		// the generated "未归类的数据库" page goes last (it is not a Notion page)
		const holder = (n: PageNode) => (n.file?.extension === 'md' && this.app.metadataCache.getFileCache(n.file)?.frontmatter?.['notion-holder'] ? 1 : 0);
		return [...kids].sort((a, b) => {
			const ha = holder(a), hb = holder(b);
			if (ha !== hb) return ha - hb;
			const pa = pos.get(a.key), pb = pos.get(b.key);
			if (pa !== undefined && pb !== undefined) return pa - pb;
			if (pa !== undefined) return -1;
			if (pb !== undefined) return 1;
			return byTitle(a, b);
		});
	}
}

// ---------------------------------------------------------------- operations

export function uniquePath(app: App, folder: string, base: string, ext: string): string {
	const pre = folder && folder !== '/' ? folder + '/' : '';
	const name = uniqueName(base, n => !!app.vault.getAbstractFileByPath(normalizePath(`${pre}${n}.${ext}`)) || !!app.vault.getAbstractFileByPath(normalizePath(`${pre}${n}`)));
	return normalizePath(`${pre}${name}.${ext}`);
}

export async function ensureFolder(app: App, path: string): Promise<TFolder> {
	path = normalizePath(path);
	const ex = app.vault.getAbstractFileByPath(path);
	if (ex instanceof TFolder) return ex;
	if (ex) throw new Error(`“${path}” 已存在且不是文件夹`);
	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	if (parent) await ensureFolder(app, parent);
	try { await app.vault.createFolder(path); } catch { /* created concurrently */ }
	return app.vault.getAbstractFileByPath(path) as TFolder;
}

/** Folder a new sub-page of `parent` goes into (creates P/ next to P.md when needed — nothing is moved). */
export async function subPageFolder(app: App, model: PageModel, parent: PageNode | null, topFolder: string): Promise<string> {
	if (!parent) return topFolder;
	if (parent.folder && parent.kind !== 'database') return parent.folder.path;
	if (parent.kind === 'database') return parent.folder ? parent.folder.path : (parent.file!.parent?.path ?? '');
	const f = parent.file!;
	const dir = f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '';
	return (await ensureFolder(app, dir + f.basename)).path;
}

export { UNTITLED };

/** Notion "+": create an untitled page under `parent` (null = top level). Returns the new file. */
export async function createPage(app: App, model: PageModel, parent: PageNode | null, topFolder: string, opts: { linkFromParent?: boolean } = {}): Promise<TFile> {
	const folder = await subPageFolder(app, model, parent, topFolder);
	const path = uniquePath(app, folder, UNTITLED, 'md');
	const file = await app.vault.create(path, '');
	// Notion adds a page block for the new sub-page at the end of the parent page
	if (opts.linkFromParent && parent?.kind === 'page' && parent.file) {
		const link = app.fileManager.generateMarkdownLink(file, parent.file.path);
		await app.vault.process(parent.file, t => (t.length && !t.endsWith('\n') ? t + '\n' : t) + (t.trim() ? '\n' : '') + link + '\n');
	}
	return file;
}

/** Move a page (its note and its sub-page folder) or a database (its folder) into `destFolder`. */
async function movePageNow(app: App, node: PageNode, destFolder: string): Promise<boolean> {
	const dest = normalizePath(destFolder || '/');
	const pre = dest === '/' ? '' : dest + '/';
	const items: TAbstractFile[] = [];
	if (node.kind === 'database') items.push(node.folder ?? node.file!);
	else if (node.kind === 'folder') items.push(node.folder!);
	else { items.push(node.file!); if (node.folder) items.push(node.folder); }
	for (const it of items) {
		if ((it.parent?.path ?? '/') === dest) return false;          // already there
		if (app.vault.getAbstractFileByPath(pre + it.name)) { new Notice(`目标位置已有同名的“${it.name}”，没有移动`); return false; }
		if (it instanceof TFolder && (dest === it.path || dest.startsWith(it.path + '/'))) { new Notice('不能把页面移到它自己的子页面里'); return false; }
	}
	await ensureFolder(app, dest === '/' ? '' : dest).catch(() => null);
	for (const it of items) await app.fileManager.renameFile(it, pre + it.name);
	return true;
}

/** Delete like Notion: the page and its sub-pages go to the trash (Obsidian's trash setting decides where). */
async function trashPageNow(app: App, node: PageNode): Promise<void> {
	if (node.kind === 'database') { await app.fileManager.trashFile(node.folder ?? node.file!); return; }
	if (node.kind === 'folder') { await app.fileManager.trashFile(node.folder!); return; }
	if (node.folder) await app.fileManager.trashFile(node.folder);
	await app.fileManager.trashFile(node.file!);
}

async function copyFolder(app: App, from: TFolder, to: string) {
	await ensureFolder(app, to);
	for (const c of from.children) {
		if (c instanceof TFolder) await copyFolder(app, c, `${to}/${c.name}`);
		else if (c instanceof TFile) await app.vault.copy(c, `${to}/${c.name}`);
	}
}

/** Notion "Duplicate": "P (1)" next to P, with its sub-pages. */
async function duplicatePageNow(app: App, node: PageNode): Promise<TFile | null> {
	if (!node.file || node.kind !== 'page') { new Notice('只能复制页面'); return null; }
	const dir = node.file.parent?.path ?? '/';
	const pre = dir === '/' ? '' : dir + '/';
	let n = 1, name = '';
	do { name = `${node.file.basename} (${n++})`; } while (app.vault.getAbstractFileByPath(pre + name + '.md') || app.vault.getAbstractFileByPath(pre + name));
	const copy = await app.vault.copy(node.file, pre + name + '.md');
	if (node.folder) await copyFolder(app, node.folder, pre + name);
	return copy;
}

/** Rename a page: the note and its sub-page folder (folder-note structure kept). */
async function renamePageNow(app: App, node: PageNode, title: string): Promise<void> {
	const clean = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
	if (!clean || !node.file) return;
	if (node.kind === 'database') {
		const folder = node.folder;
		if (folder) {
			const pp = folder.parent && folder.parent.path !== '/' ? folder.parent.path + '/' : '';
			if (app.vault.getAbstractFileByPath(pp + clean)) { new Notice(`已有同名的“${clean}”`); return; }
			await app.fileManager.renameFile(node.file, `${folder.path}/${clean}.base`);
			await app.fileManager.renameFile(folder, pp + clean);
		} else await app.fileManager.renameFile(node.file, `${node.file.parent?.path === '/' ? '' : node.file.parent!.path + '/'}${clean}.base`);
		return;
	}
	const dir = node.file.parent?.path ?? '/';
	const target = normalizePath(`${dir === '/' ? '' : dir + '/'}${clean}.md`);
	if (target === node.file.path) return;
	if (app.vault.getAbstractFileByPath(target)) { new Notice(`已有同名页面“${clean}”`); return; }
	await app.fileManager.renameFile(node.file, target);   // the folder follows via NotionMode's rename hook
}

// Round 8: page operations run one at a time. Rapid drags / renames in the tree used to start a second move while
// Obsidian was still moving a folder from the first one (sandbox stress test: a page could end up in two places).
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(fn, fn);
	chain = run.catch(() => undefined);
	return run;
}
export const movePage = (app: App, node: PageNode, destFolder: string) => serial(() => movePageNow(app, node, destFolder));
export const trashPage = (app: App, node: PageNode) => serial(() => trashPageNow(app, node));
export const duplicatePage = (app: App, node: PageNode) => serial(() => duplicatePageNow(app, node));
export const renamePage = (app: App, node: PageNode, title: string) => serial(() => renamePageNow(app, node, title));
