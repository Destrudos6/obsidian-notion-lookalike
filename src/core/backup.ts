/* eslint-disable @typescript-eslint/no-explicit-any */
// Backup layer: raw JSON store, manifest, and the re-sync planner. Pure (no Obsidian / network) → unit-tested.
//
//   <target>/_raw/pages/<id>.json       {page, blocks, comments, incomplete, fetchedAt}   exact API objects
//   <target>/_raw/databases/<id>.json   {database, views, data_sources:[{data_source, rows}]}
//   <target>/_raw/markdown/<id>.json    GET /pages/{id}/markdown (Notion's own Markdown, optional second copy)
//   <target>/_raw/manifest.json         what was written where (+ content hashes) by the last run
//
// Re-sync rules: a note is overwritten only when it still has the content this importer wrote last time;
// otherwise the local version is copied to _本地修改备份/<time>/ first. Renamed Notion pages are moved (links
// updated by Obsidian). Pages that disappeared from Notion are moved to _已在Notion删除/ – only after a
// complete crawl with the same scope; nothing is ever deleted.
import type { OutFile, Snapshot } from './types.ts';
import { hash, joinPath, normId } from './util.ts';
import { displayOf, withDisplay, withoutDisplay } from './display.ts';

export const MANIFEST_VERSION = 1;

export interface Manifest {
	version: number;
	plugin?: string;
	startedAt: string;
	finishedAt?: string;
	complete: boolean;
	inProgress?: boolean;
	scope: string[];                         // root ids ([] = everything shared with the integration)
	files: Record<string, { id?: string; hash: string }>;   // vault path → content hash written by us
	ids: Record<string, string>;             // notion id (normalized) → vault path
	assets: Record<string, string>;          // file URL key → vault path
	errors?: string[];                       // crawl problems of the run behind the raw store (kept for offline rebuilds)
	relocated?: Record<string, string>;      // id → path the USER moved / renamed it to (kept there on every re-sync)
	/** round 8: quick (incremental) runs since the last full verification, and when that full run started */
	quickRuns?: number;
	lastFull?: string;
	mode?: 'full' | 'quick';
}

/** Quick re-sync policy: only after a complete earlier run, at most 4 quick runs in a row and at most 7 days after
 *  the last full verification; "完整校验同步" (full) always wins. */
export function chooseSyncMode(prev: Manifest | null, opt: { incremental?: boolean; full?: boolean }, now: Date): 'full' | 'quick' {
	if (opt.full || opt.incremental === false || !prev || !prev.complete || prev.inProgress) return 'full';
	if ((prev.quickRuns ?? 0) >= 4) return 'full';
	const last = Date.parse(prev.lastFull ?? '');
	if (!isFinite(last) || now.getTime() - last > 7 * 86400000) return 'full';
	return 'quick';
}

export const rawDir = (target: string) => joinPath(target, '_raw');
export const rawPagePath = (target: string, id: string) => joinPath(rawDir(target), 'pages', normId(id) + '.json');
export const rawDbPath = (target: string, id: string) => joinPath(rawDir(target), 'databases', normId(id) + '.json');
export const rawMarkdownPath = (target: string, id: string) => joinPath(rawDir(target), 'markdown', normId(id) + '.json');
export const manifestPath = (target: string) => joinPath(rawDir(target), 'manifest.json');
export const contentHash = (s: string) => hash(s) + hash('~' + s) + s.length.toString(16);

/** Rebuild a Snapshot from the raw store (re-convert without network, e.g. after a converter upgrade). */
export function snapshotFromRaw(pages: any[], databases: { id: string; raw: any }[], scope: string[], comments = true): Snapshot {
	const snap: Snapshot = { roots: [], pages: {}, databases: {}, comments: {}, users: {}, errors: [], complete: true };
	for (const p of pages) {
		if (!p?.page?.id) continue;
		snap.pages[p.page.id] = { page: p.page, blocks: p.blocks || [] };
		if (comments) Object.assign(snap.comments!, p.comments || {});
		if (p.incomplete) { snap.complete = false; snap.errors!.push(`raw copy of page ${p.page.id} is incomplete`); }
	}
	for (const d of databases) snap.databases[d.id] = d.raw;
	if (scope.length) snap.roots = scope;
	else {
		const ids = new Set(pages.map(p => normId(p?.page?.id)));
		snap.roots = pages.filter(p => p?.page && (p.page.parent?.type === 'workspace' || (p.page.parent?.type === 'page_id' && !ids.has(normId(p.page.parent.page_id))))).map(p => p.page.id);
	}
	return snap;
}

/** The notion id a vault file stands for: `notion-id` in a note's frontmatter, `notion: data-source:` in a .base
 *  (+ the generated "未归类的数据库" page). Used to find imported items the user moved / renamed locally. */
export function notionIdOf(path: string, text: string): string | null {
	if (/\.md$/i.test(path)) {
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		if (!fm) return null;
		const m = /^notion-id:\s*["']?([0-9a-fA-F-]{32,36})["']?\s*$/m.exec(fm[1]);
		if (m) return normId(m[1]);
		if (/^notion-holder:\s*["']?unclassified["']?\s*$/m.test(fm[1])) return 'holder:unclassified';
		return null;
	}
	if (/\.base$/i.test(path)) {
		const m = /^\s+["']?data-source["']?:\s*["']?([0-9a-fA-F-]{32,36})["']?\s*$/m.exec(text);
		return m ? normId(m[1]) : null;
	}
	return null;
}

/** folders of the importer that never count as "the user's place" for a page */
const BOOKKEEPING = /(^|\/)(_raw|_本地修改备份|_同步冲突|_已在Notion删除|\.trash|\.obsidian)(\/|$)/;

/** For every id imported last time whose note is no longer at the recorded path but exists elsewhere in the vault
 *  (moved / renamed by the user): id → that path. Ambiguous ids (several copies, none at the recorded path) are
 *  left out and reported. */
export function findRelocations(prev: Manifest | null, located: Record<string, string[]>): { relocate: Record<string, string>; ambiguous: string[] } {
	const relocate: Record<string, string> = {}; const ambiguous: string[] = [];
	if (!prev) return { relocate, ambiguous };
	for (const [id, recorded] of Object.entries(prev.ids || {})) {
		const here = (located[id] || []).filter(p => !BOOKKEEPING.test(p));
		if (!here.length) continue;
		if (here.some(p => lc(p) === lc(recorded))) {
			// moved by the user in an earlier run and still there: stays the user's place
			if (prev.relocated?.[id] && lc(prev.relocated[id]) === lc(recorded)) relocate[id] = recorded;
			continue;
		}
		if (here.length === 1) relocate[id] = here[0]; else ambiguous.push(`${id}: ${here.join(' | ')}`);
	}
	return { relocate, ambiguous };
}

export interface SyncPlan {
	renames: { from: string; to: string }[];
	backups: { from: string; to: string }[];       // copy local edits away before overwriting
	writes: OutFile[];
	unchanged: string[];
	archive: { from: string; to: string }[];       // removed in Notion → moved, not deleted
	keptMissing: string[];                          // not seen this run, but crawl incomplete / scope changed → left alone
	/** edited locally, Notion version unchanged since the last sync → the local file is kept as it is (no write) */
	keptLocal: string[];
	/** edited locally AND changed in Notion (both sides differ from what the last sync wrote) */
	conflicts: Conflict[];
	/** conflicts resolved "keep local": the Notion version is written next to it (never lost) */
	notionCopies: { path: string; copy: string }[];
}

export type ConflictChoice = 'local' | 'notion';
export interface Conflict {
	path: string;
	id?: string;
	/** the converted Notion version (written to `copy` when the local version is kept) */
	copy: string;
	/** where the local version goes when the user picks "用 Notion 覆盖" */
	backup: string;
	localLines: { added: number; removed: number };   // local vs. last synced is unknown; local vs. Notion version
	choice: ConflictChoice;
}

/** rough "+a −r lines" between two texts (multiset of lines) */
export function lineDelta(from: string, to: string): { added: number; removed: number } {
	const count = new Map<string, number>();
	for (const l of from.split('\n')) count.set(l, (count.get(l) || 0) + 1);
	let added = 0;
	for (const l of to.split('\n')) { const n = count.get(l) || 0; if (n > 0) count.set(l, n - 1); else added++; }
	let removed = 0; for (const n of count.values()) removed += n;
	return { added, removed };
}

export interface SyncInput {
	target: string;
	prev: Manifest | null;
	files: OutFile[];
	idPaths: Record<string, string>;               // normalized notion id → new path
	read: (path: string) => string | null;          // current vault content (null = no file)
	complete: boolean;
	scope: string[];
	stamp: string;                                  // e.g. 2026-11-08 0930
	/** ids skipped on purpose (ignore list): their local files are left exactly as they are */
	skip?: Set<string>;
	/** per-path decision for conflicts (default: keep local + Notion copy alongside) */
	resolve?: Record<string, ConflictChoice>;
}

const lc = (s: string) => s.toLowerCase();

export function planSync(i: SyncInput): SyncPlan {
	const plan: SyncPlan = { renames: [], backups: [], writes: [], unchanged: [], archive: [], keptMissing: [], keptLocal: [], conflicts: [], notionCopies: [] };
	const conflictRoot = joinPath(i.target, '_同步冲突', i.stamp);
	const pathToId = new Map<string, string>();
	for (const [id, p] of Object.entries(i.idPaths)) pathToId.set(lc(p), normId(id));
	const taken = new Set(i.files.map(f => lc(f.path)));
	const backupRoot = joinPath(i.target, '_本地修改备份', i.stamp);
	const rel = (p: string) => p.startsWith(i.target + '/') ? p.slice(i.target.length + 1) : p;
	const prevFiles = i.prev?.files || {};
	const movedAway = new Set<string>();

	for (const f of i.files) {
		const id = pathToId.get(lc(f.path));
		let existing = i.read(f.path);
		// renamed / moved in Notion: move the old note (Obsidian updates links), then update it in place
		const old = id ? i.prev?.ids[id] : undefined;
		if (old && lc(old) !== lc(f.path) && existing === null && !taken.has(lc(old)) && i.read(old) !== null) {
			plan.renames.push({ from: old, to: f.path });
			movedAway.add(lc(old));
			existing = i.read(old);
		}
		if (existing === null) { plan.writes.push(f); continue; }
		// page display settings (···: full width, font, small text, lock) are local-only: kept, never a "local edit"
		const disp = /\.md$/.test(f.path) ? displayOf(existing) : null;
		const content = disp && (disp.classes.length || Object.keys(disp.keys).length) ? withDisplay(f.content, disp) : f.content;
		if (existing === content) { plan.unchanged.push(f.path); continue; }
		const recorded = (old && prevFiles[old]) || prevFiles[f.path];
		const untouched = recorded && (contentHash(existing) === recorded.hash || (disp !== null && contentHash(withoutDisplay(existing)) === recorded.hash));
		const out = content === f.content ? f : { ...f, content };
		if (untouched) { plan.writes.push(out); continue; }
		const backup = joinPath(backupRoot, rel(f.path));
		if (recorded) {
			// edited locally. Notion side unchanged (same output as last time) → nothing to bring in: keep local
			if (contentHash(f.content) === recorded.hash || contentHash(content) === recorded.hash) { plan.keptLocal.push(f.path); continue; }
			// both changed → conflict; safe default = keep local, Notion version saved next to it
			const choice: ConflictChoice = i.resolve?.[f.path] === 'notion' ? 'notion' : 'local';
			const copy = joinPath(conflictRoot, rel(f.path));
			plan.conflicts.push({ path: f.path, id, copy, backup, localLines: lineDelta(content, existing), choice });
			if (choice === 'notion') { plan.backups.push({ from: f.path, to: backup }); plan.writes.push(out); }
			else plan.notionCopies.push({ path: f.path, copy });
			continue;
		}
		// no record of what we wrote (file created outside the importer at this path): back up, then write
		plan.backups.push({ from: f.path, to: backup });
		plan.writes.push(out);
	}

	// pages / databases that were imported before and are gone now
	const sameScope = JSON.stringify([...(i.prev?.scope || [])].map(normId).sort()) === JSON.stringify([...i.scope].map(normId).sort());
	for (const [id, path] of Object.entries(i.prev?.ids || {})) {
		if (i.idPaths[id] !== undefined || movedAway.has(lc(path)) || taken.has(lc(path))) continue;
		if (i.skip?.has(normId(id))) continue;
		if (i.read(path) === null) continue;
		if (i.complete && sameScope) plan.archive.push({ from: path, to: joinPath(i.target, '_已在Notion删除', rel(path)) });
		else plan.keptMissing.push(path);
	}
	return plan;
}

export function newManifest(scope: string[], startedAt: string, plugin?: string): Manifest {
	return { version: MANIFEST_VERSION, plugin, startedAt, complete: false, inProgress: true, scope, files: {}, ids: {}, assets: {} };
}
