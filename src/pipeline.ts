/* eslint-disable @typescript-eslint/no-explicit-any */
// The whole backup run, independent of Obsidian (the plugin and the Node scripts/tests plug in their own I/O):
// crawl (raw JSON + files saved the moment they are seen) → convert → download what is left → re-sync plan →
// write → verify → report + manifest.
import { NotionCrawler, withTimeout, type PageRaw, type Transport } from './api/crawler.ts';
import { verify, verifyMarkdown, walkBlocks, type VerifyLine } from './core/audit.ts';
import { contentHash, findRelocations, manifestPath, newManifest, notionIdOf, planSync, rawDbPath, rawDir, rawMarkdownPath, rawPagePath, snapshotFromRaw, chooseSyncMode, type ConflictChoice, type Manifest, type SyncPlan } from './core/backup.ts';
import { assetPath, collectFileUrls } from './core/context.ts';
import { convertSnapshot } from './core/convert.ts';
import { formulaReportMarkdown } from './core/formula.ts';
import type { ConvertResult, Snapshot } from './core/types.ts';
import { DEFAULT_OPTIONS } from './core/types.ts';
import { joinPath, normId, stripQuery } from './core/util.ts';

export interface VaultIO {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	size(path: string): Promise<number>;                 // -1 when missing
	rename(from: string, to: string): Promise<void>;     // Obsidian: fileManager.renameFile (links follow)
	copy(from: string, to: string): Promise<void>;
	list(folder: string): Promise<string[]>;             // file paths directly inside folder
	remove?(path: string): Promise<void>;
	/** every .md / .base path in the vault (to find imported notes the user moved or renamed) */
	listAll?(): Promise<string[]>;
	/** faster alternative to listAll + read: notion id → paths (the plugin reads Obsidian's metadata cache) */
	notionIndex?(): Promise<Record<string, string[]>>;
	/** remove a folder only if it is empty (left behind after the importer moved everything out of it) */
	removeEmptyDir?(path: string): Promise<boolean>;
}

/** notion id → vault paths of the notes / bases that carry it */
export async function locateNotionIds(io: VaultIO): Promise<Record<string, string[]>> {
	if (io.notionIndex) return io.notionIndex();
	const out: Record<string, string[]> = {};
	if (!io.listAll) return out;
	for (const p of await io.listAll()) {
		if (!/\.(md|base)$/i.test(p)) continue;
		const t = await io.read(p);
		const id = t ? notionIdOf(p, t) : null;
		if (id) (out[id] ||= []).push(p);
	}
	return out;
}

export type Fetcher = (url: string) => Promise<{ status: number; data: ArrayBuffer; contentType?: string }>;

export interface BackupSettings {
	target: string;
	roots: string[];
	rowBodies: boolean;
	comments: 'none' | 'pages' | 'all';
	downloadExternal: boolean;
	coloredPills: boolean;
	staticHeader: boolean;
	/** back up database templates (default true) */
	templates?: boolean;
	/** also save Notion's own Markdown of each page in _raw/markdown/ (1 read-only request per page) */
	markdownCopy?: boolean;
	/** notion ids the user chose "以后不再同步" for (still backed up in _raw; notes not written / not archived) */
	ignore?: string[];
	timeZone?: string;
	pluginVersion?: string;
	minInterval?: number;
	sleep?: (ms: number) => Promise<void>;
	/** round 8: quick re-sync (default true): skip unchanged pages/databases by last_edited_time signals */
	incremental?: boolean;
	/** "完整校验同步": read everything again this time */
	fullVerify?: boolean;
	/** asked before anything is written when pages were changed both locally and in Notion; the default
	 *  (no callback / not answered) keeps the local version and saves the Notion version next to it */
	resolveConflicts?: (c: ConflictInfo[]) => Promise<Record<string, ConflictChoice> | null>;
}

export interface ConflictInfo { path: string; title: string; notionEdited?: string; localEdited?: string; added: number; removed: number; copy: string; backup: string }

export interface BackupResult { snap: Snapshot; res?: ConvertResult; plan?: SyncPlan; lines: VerifyLine[]; reportPath: string; complete: boolean }

export const REPORT_NAME = '_导入报告.md';

/** Raw JSON as written to disk: signed file URLs lose their query string (temporary AWS credentials that expire
 *  after ~1 h anyway; the file itself is downloaded and the stable URL path is kept). */
export const rawJson = (o: unknown) => JSON.stringify(o, (k, v) => (typeof v === 'string' && /[?&]X-Amz-(Signature|Credential)=/.test(v) ? stripQuery(v) : v));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function stampOf(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Download with retries; skips files already on disk (resume). Returns an error string or null. */
async function download(io: VaultIO, fetcher: Fetcher, url: string, path: string, wait: (ms: number) => Promise<void>, external = false): Promise<string | null> {
	if ((await io.size(path)) > 0) return null;
	let last = '';
	for (let a = 0; a < 4; a++) {
		try {
			const r = await withTimeout(fetcher(url), 300000);
			if (r.status >= 200 && r.status < 300 && r.data.byteLength > 0) {
				if (external && /text\/html/i.test(r.contentType || '')) return 'not a file (web page)';
				await io.writeBinary(path, r.data); return null;
			}
			last = `HTTP ${r.status}`;
			if (r.status === 403 || r.status === 404 || r.status === 400) break;   // expired signature / gone: retrying won't help
		} catch (e) { last = (e as Error).message; }
		await wait(1000 * 2 ** a);
	}
	return last || 'failed';
}

export async function runBackup(io: VaultIO, transport: Transport, fetcher: Fetcher, s: BackupSettings,
	log: (m: string) => void = () => {}, cancelled: () => boolean = () => false, now: () => Date = () => new Date()): Promise<BackupResult> {
	const target = s.target;
	const wait = s.sleep ?? sleep;
	const reportPath = joinPath(target, REPORT_NAME);
	const prevText = await io.read(manifestPath(target));
	let prev: Manifest | null = null;
	try { prev = prevText ? JSON.parse(prevText) : null; } catch { prev = null; }
	const started = now();
	const opts = { targetFolder: target, attachmentsFolder: DEFAULT_OPTIONS.attachmentsFolder };

	// a half-finished vault must never look complete
	await io.write(reportPath, `# Notion 导入报告\n\n> [!warning] 导入进行中（开始于 ${started.toISOString()}）\n> 如果你看到这条提示而导入已经不在运行，说明上次导入被中断了：库里的内容**不完整**。重新运行导入即可从中断处继续（已备份的页面和附件不会重复下载）。\n`);
	await io.write(joinPath(rawDir(target), 'in-progress.json'), JSON.stringify({ startedAt: started.toISOString() }));

	const assetErr = new Map<string, string>();      // url key → error
	const assetOk = new Set<string>();
	const extCopies: Record<string, string> = {};
	const grab = async (obj: unknown) => {
		for (const url of new Set(collectFileUrls(obj))) {
			const key = stripQuery(url);
			if (assetOk.has(key)) continue;
			const e = await download(io, fetcher, url, assetPath(key, opts), wait);
			if (e) assetErr.set(key, e); else { assetOk.add(key); assetErr.delete(key); }
		}
		if (s.downloadExternal) {
			const ext = collectFileUrls(obj, [], true).filter(u => !/youtu\.?be|vimeo\.com|bilibili\.com/.test(u));
			for (const url of new Set(ext)) {
				const key = stripQuery(url);
				if (assetOk.has(key) || extCopies[key]) continue;
				const path = assetPath(key, { targetFolder: target, attachmentsFolder: DEFAULT_OPTIONS.attachmentsFolder + '/external' });
				const e = await download(io, fetcher, url, path, wait, true);
				if (!e) extCopies[key] = path;
			}
		}
	};

	let rawPages = 0, rawDbs = 0;
	const mode = chooseSyncMode(prev, { incremental: s.incremental, full: s.fullVerify }, started);
	log(mode === 'quick' ? '快速同步：只读取 Notion 里有变化的页面和数据库' : '完整同步：重新读取全部内容');
	const crawler = new NotionCrawler(transport, {
		incremental: mode === 'quick',
		reuseDatabase: async id => { const t = await io.read(rawDbPath(target, id)); return t ? JSON.parse(t) : undefined; },
		rootIds: s.roots, rowBodies: s.rowBodies, comments: s.comments, onProgress: log, isCancelled: cancelled, minInterval: s.minInterval, sleep: s.sleep,
		onPage: async (id, raw) => { await io.write(rawPagePath(target, id), rawJson(raw)); rawPages++; await grab(raw); },
		onDatabase: async (id, raw) => { await io.write(rawDbPath(target, id), rawJson(raw)); rawDbs++; await grab(raw); },
		templates: s.templates !== false, markdown: !!s.markdownCopy,
		onMarkdown: async (id, md) => { await io.write(rawMarkdownPath(target, id), rawJson(md)); },
		hasMarkdown: async id => (await io.size(rawMarkdownPath(target, id))) > 0,
		reuse: async (id, lastEdited) => {
			const t = await io.read(rawPagePath(target, id));
			if (!t) return undefined;
			try { const r = JSON.parse(t) as PageRaw; return r.page?.last_edited_time === lastEdited && !r.incomplete ? r : undefined; } catch { return undefined; }
		},
	});
	log('读取 Notion…');
	const snap = await crawler.run();
	(snap as any).syncMode = mode;
	return finish(io, fetcher, s, snap, prev, { rawPages, rawDbs }, { assetOk, assetErr, extCopies }, started, log, cancelled, wait, reportPath);
}

/** Re-convert from the raw backup only (no network): for converter upgrades or a damaged vault. */
export async function rebuildFromRaw(io: VaultIO, fetcher: Fetcher, s: BackupSettings, log: (m: string) => void = () => {}, now: () => Date = () => new Date()): Promise<BackupResult> {
	const target = s.target;
	const pages: any[] = []; const dbs: { id: string; raw: any }[] = [];
	for (const p of await io.list(joinPath(rawDir(target), 'pages'))) { const t = await io.read(p); if (t) pages.push(JSON.parse(t)); }
	for (const p of await io.list(joinPath(rawDir(target), 'databases'))) { const t = await io.read(p); if (t) dbs.push({ id: p.split('/').pop()!.replace(/\.json$/, ''), raw: JSON.parse(t) }); }
	const prevText = await io.read(manifestPath(target));
	const prev: Manifest | null = prevText ? JSON.parse(prevText) : null;
	const snap = snapshotFromRaw(pages, dbs, prev?.scope ?? s.roots);
	snap.complete = prev?.complete ?? false;   // archiving only if the crawl behind the raw store was complete
	snap.errors = [...(snap.errors || []), ...(prev?.errors || [])];   // e.g. "comments not backed up" stays visible
	const assetOk = new Set<string>(); const assetErr = new Map<string, string>();
	return finish(io, fetcher, { ...s, roots: prev?.scope ?? s.roots }, snap, prev, { rawPages: pages.length, rawDbs: dbs.length }, { assetOk, assetErr, extCopies: {} }, now(), log, () => false, s.sleep ?? sleep, joinPath(target, REPORT_NAME));
}

async function finish(io: VaultIO, fetcher: Fetcher, s: BackupSettings, snap: Snapshot, prev: Manifest | null, raw: { rawPages: number; rawDbs: number },
	a: { assetOk: Set<string>; assetErr: Map<string, string>; extCopies: Record<string, string> }, started: Date, log: (m: string) => void, cancelled: () => boolean,
	wait: (ms: number) => Promise<void>, reportPath: string): Promise<BackupResult> {
	const target = s.target;
	if (cancelled()) {
		const lines = verify({ snap, audit: { renderedBlocks: new Set(), unsupportedBlocks: {}, propsWritten: 0, propsLive: 0, propsEmpty: 0, propsFallback: {}, unresolvedLinks: 0, commentsRendered: 0, pagesWritten: 0, rowsWritten: {}, orphansPlaced: 0, templatesWritten: 0 },
			pageIdsWritten: new Set(), blocksExpected: new Set(), commentsExpected: 0, assetsRequested: 0, assetsOk: 0, assetFailures: [] });
		await io.write(reportPath, `# Notion 导入报告\n\n> [!danger] 导入被取消 —— 这不是完整备份\n> 已抓取 ${raw.rawPages} 个页面、${raw.rawDbs} 个数据库的原始数据（保存在 _raw/）。重新运行导入会从这里继续。\n\n${verifyMarkdown(lines)}`);
		return { snap, lines, reportPath, complete: false };
	}
	log(`读取完成：${Object.keys(snap.pages).length} 页面，${Object.keys(snap.databases).length} 数据库。转换中…`);
	// imported pages / databases the user moved or renamed in the vault are updated where they are now
	const located = prev ? await locateNotionIds(io) : {};
	const { relocate, ambiguous } = findRelocations(prev, located);
	const res = convertSnapshot(snap, { ...DEFAULT_OPTIONS, targetFolder: target, coloredPills: s.coloredPills, staticHeader: s.staticHeader, timeZone: s.timeZone, relocate, ignore: s.ignore });
	for (const a of ambiguous) res.warnings.push(`同一个 Notion 页面在库里有多份副本，且都不在原来的位置，没有自动选择：${a}`);
	const skipIds = new Set((res.skipped || []).map(x => normId(x.id)));
	const relocatedUsed = Object.entries(relocate).filter(([id, p]) => res.idPaths[id] === p);

	// files referenced by the output that were not downloaded during the crawl (reused pages, rebuilds)
	let i = 0;
	for (const as of res.assets) {
		if (cancelled()) break;
		if (a.assetOk.has(as.key)) continue;
		if (++i % 10 === 0) log(`下载附件 ${i}`);
		const e = await download(io, fetcher, as.url, as.path, wait);
		if (e) a.assetErr.set(as.key, e); else { a.assetOk.add(as.key); a.assetErr.delete(as.key); }
	}
	const failures: string[] = [];
	let ok = 0;
	for (const as of res.assets) { if ((await io.size(as.path)) > 0) ok++; else failures.push(`${as.key.slice(0, 120)} (${a.assetErr.get(as.key) || 'missing'})`); }

	// re-sync plan against what is in the vault now
	const current = new Map<string, string | null>();
	for (const f of res.files) current.set(f.path, await io.read(f.path));
	for (const p of Object.values(prev?.ids || {})) if (!current.has(p)) current.set(p, await io.read(p));
	const syncIn = { target, prev, files: res.files, idPaths: res.idPaths, read: (p: string) => current.get(p) ?? null, complete: snap.complete !== false && !cancelled(), scope: s.roots, stamp: stampOf(started), skip: skipIds };
	let plan = planSync(syncIn);
	if (plan.conflicts.length && s.resolveConflicts) {
		const editedOf = (id?: string) => { const pg = id ? Object.values(snap.pages).find(x => normId(x.page?.id) === id)?.page : undefined; return pg?.last_edited_time as string | undefined; };
		const dsEdited = (id?: string) => { if (!id) return undefined; for (const d of Object.values(snap.databases) as any[]) for (const x of d?.data_sources || []) if (normId(x?.data_source?.id) === id) return x.data_source.last_edited_time as string | undefined; return undefined; };
		const info: ConflictInfo[] = plan.conflicts.map(c => ({ path: c.path, title: c.path.split('/').pop()!.replace(/\.(md|base)$/, ''), notionEdited: editedOf(c.id) ?? dsEdited(c.id), added: c.localLines.added, removed: c.localLines.removed, copy: c.copy, backup: c.backup }));
		let choice: Record<string, ConflictChoice> | null = null;
		try { choice = await s.resolveConflicts(info); } catch { choice = null; }
		if (choice) plan = planSync({ ...syncIn, resolve: choice });
	}
	log(`写入：新建/更新 ${plan.writes.length}，未变 ${plan.unchanged.length}，保留本地修改 ${plan.keptLocal.length}，冲突 ${plan.conflicts.length}，本地修改备份 ${plan.backups.length}，改名 ${plan.renames.length}，归档 ${plan.archive.length}`);
	for (const r of plan.renames) await io.rename(r.from, r.to);
	for (const b of plan.backups) await io.copy(b.from, b.to);
	const contentOf = new Map(res.files.map(f => [f.path, f.content]));
	for (const c of plan.notionCopies) await io.write(c.copy, contentOf.get(c.path) ?? '');
	let w = 0;
	for (const f of plan.writes) { await io.write(f.path, f.content); if (++w % 50 === 0) log(`写入 ${w}/${plan.writes.length}`); }
	for (const r of plan.archive) await io.rename(r.from, r.to);
	// folders the importer emptied by moving things out (e.g. the old "Databases" holder) – only if really empty
	if (io.removeEmptyDir) {
		const dirs = new Set<string>();
		for (const r of [...plan.renames, ...plan.archive]) {
			let d = r.from.includes('/') ? r.from.slice(0, r.from.lastIndexOf('/')) : '';
			while (d && d !== target && d.startsWith(target + '/')) { dirs.add(d); d = d.slice(0, d.lastIndexOf('/')); }
		}
		for (const d of [...dirs].sort((a, b) => b.length - a.length)) await io.removeEmptyDir(d);
	}

	// verification
	const blocksExpected = new Set<string>();
	const written = new Set(Object.keys(res.idPaths));
	for (const [id, ps] of Object.entries(snap.pages)) if (written.has(normId(id))) walkBlocks(ps.blocks, b => { if (b.id) blocksExpected.add(b.id); });
	const commentsExpected = new Set(Object.values(snap.comments || {}).flat().map((c: any) => c.id)).size;
	let markdownCopies: { expected: number; saved: number } | undefined;
	if (s.markdownCopy) {
		const ids = Object.keys(snap.pages).filter(id => !snap.pages[id].page?.__error && written.has(normId(id)));
		let saved = 0;
		for (const id of ids) if ((await io.size(rawMarkdownPath(target, id))) > 0) saved++;
		markdownCopies = { expected: ids.length, saved };
	}
	const lines = verify({ snap, audit: res.audit, pageIdsWritten: written, blocksExpected, commentsExpected, assetsRequested: res.assets.length, assetsOk: ok, assetFailures: failures, rawSaved: { pages: raw.rawPages, databases: raw.rawDbs }, markdownCopies, skippedIds: skipIds });

	const manifest: Manifest = { ...newManifest(s.roots, started.toISOString(), s.pluginVersion), inProgress: false, finishedAt: new Date().toISOString(), complete: snap.complete !== false };
	for (const f of res.files) manifest.files[f.path] = { hash: contentHash(f.content) };
	manifest.ids = { ...res.idPaths };
	// skipped on purpose: remember where the local copy is, so it is never treated as "deleted in Notion"
	for (const id of skipIds) if (prev?.ids[id] && manifest.ids[id] === undefined) { manifest.ids[id] = prev.ids[id]; const h = prev.files[prev.ids[id]]; if (h) manifest.files[prev.ids[id]] = h; }
	manifest.errors = [...new Set(snap.errors || [])];
	const runMode: 'full' | 'quick' | undefined = (snap as any).syncMode;
	if (runMode === 'quick') { manifest.mode = 'quick'; manifest.quickRuns = (prev?.quickRuns ?? 0) + 1; manifest.lastFull = prev?.lastFull; }
	else if (runMode === 'full') { manifest.mode = 'full'; manifest.quickRuns = 0; manifest.lastFull = started.toISOString(); }
	else { manifest.quickRuns = prev?.quickRuns; manifest.lastFull = prev?.lastFull; }   // offline rebuild: keep the counters
	if (relocatedUsed.length) manifest.relocated = Object.fromEntries(relocatedUsed);
	for (const as of res.assets) manifest.assets[as.key] = as.path;
	Object.assign(manifest.assets, a.extCopies);
	await io.write(manifestPath(target), JSON.stringify(manifest, null, 1));
	await io.remove?.(joinPath(rawDir(target), 'in-progress.json'));

	const bad = lines.filter(l => !l.ok).length;
	const wl = (p: string, label?: string) => `[[${p.replace(/\.md$/, '')}|${(label ?? p.split('/').pop()!.replace(/\.md$/, '')).replace(/[|\]]/g, ' ')}]]`;
	const report = [
		'# Notion 导入报告', '',
		`导入时间：${started.toISOString()} → ${manifest.finishedAt}　|　范围：${s.roots.length ? s.roots.join(', ') : 'integration 可见的全部页面'}　|　${snap.complete !== false ? '抓取完整' : '**抓取不完整**'}`, '',
		'## 1. 校验（Notion ↔ Obsidian）', '', verifyMarkdown(lines),
		'## 2. 本次同步', '',
		(snap as any).syncMode ? `- 方式：${(snap as any).syncMode === 'quick' ? `快速同步（沿用未变化的页面 ${snap.stats?.reusedPages ?? 0}、未变化的数据库 ${snap.stats?.reusedDatabases ?? 0}；每 5 次或 7 天自动做一次完整校验）` : '完整同步（全部重新读取）'}` : null,
		`- 新建/更新：${plan.writes.length}　未变化：${plan.unchanged.length}`,
		`- 本地修改先备份到 \`${target}/_本地修改备份/\`：${plan.backups.length}${plan.backups.length ? '\n' + plan.backups.slice(0, 50).map(b => `  - ${b.from} → ${b.to}`).join('\n') : ''}`,
		`- 在 Notion 中改名/移动（已在库中移动，链接自动更新）：${plan.renames.length}${plan.renames.length ? '\n' + plan.renames.slice(0, 50).map(r => `  - ${r.from} → ${r.to}`).join('\n') : ''}`,
		`- 在 Notion 中已删除 → 移到 \`${target}/_已在Notion删除/\`（不会删除任何文件）：${plan.archive.length}${plan.archive.length ? '\n' + plan.archive.slice(0, 50).map(r => `  - ${r.from}`).join('\n') : ''}`,
		`- 只在本地修改过、Notion 那边没变 → 保留你的本地版本（没有覆盖）：${plan.keptLocal.length}${plan.keptLocal.length ? '\n' + plan.keptLocal.slice(0, 50).map(p => `  - ${wl(p)}`).join('\n') : ''}`,
		`- 两边都改过（冲突）：${plan.conflicts.length}${plan.conflicts.length ? '\n' + plan.conflicts.slice(0, 50).map(c => c.choice === 'local' ? `  - ${wl(c.path)}：保留本地，Notion 版本另存为 ${wl(c.copy, 'Notion 版本')}` : `  - ${wl(c.path)}：用 Notion 覆盖，本地版本备份在 ${wl(c.backup, '本地备份')}`).join('\n') : ''}`,
		plan.keptMissing.length ? `- 本次没看到但保留原样（抓取不完整或导入范围变了）：${plan.keptMissing.length}` : null,
		`- 你在库里移动/改名过的页面和数据库（在你放的位置更新，不会再建一份）：${relocatedUsed.length}${(() => { const nw = relocatedUsed.filter(([id, p]) => prev?.ids[id] !== p); return nw.length ? `（本次新发现 ${nw.length}）\n` + nw.slice(0, 50).map(([id, p]) => `  - ${prev?.ids[id] ?? id} → ${p}`).join('\n') : ''; })()}`,
		`- 以后不再同步（按你的设置跳过；原始数据照常备份在 _raw，本地已有文件保持原样）：${(res.skipped || []).length}${(res.skipped || []).length ? '\n' + (res.skipped || []).filter(x => x.kind === 'page' || x.kind === 'database').slice(0, 50).map(x => `  - ${x.kind === 'database' ? '数据库' : '页面'}「${x.title || x.id}」`).join('\n') + `\n  - （共 ${(res.skipped || []).filter(x => x.kind === 'row').length} 行、${(res.skipped || []).filter(x => x.kind === 'template').length} 个模板随之跳过）` : ''}`,
		'', '## 变更记录', '',
		'本次同步改动了库里已有内容的文件（新文件不列出）。点链接可以打开；被覆盖前的本地版本都有备份。', '',
		changeLog(plan, current, wl),
		'', '## 3. 原始数据备份', '',
		`Notion API 返回的原始 JSON（每个页面、块、数据库、视图、数据库模板、评论）都保存在 \`${rawDir(target)}/\`${s.markdownCopy ? '，另外 `_raw/markdown/` 里有 Notion 自己导出的 Markdown（第二份原始副本）' : ''}，Markdown 转换不完美的地方也不会丢数据，以后的版本可以用「从原始备份重新生成」重新转换。`,
		'', '## 4. 警告', '', [...new Set(res.warnings)].map(x => '- ' + x).join('\n') || '- 无', '',
		formulaReportMarkdown(res.formulaReport),
	].filter(x => x !== null).join('\n');
	await io.write(reportPath, report + "\n");
	log(bad ? `完成，但有 ${bad} 处不一致 —— 见导入报告` : '完成 ✔ 校验通过');
	return { snap, res, plan, lines, reportPath, complete: snap.complete !== false };
}

/** "变更记录": every existing file this run replaced, with its backup (if it had local edits) */
export function changeLog(plan: SyncPlan, before: Map<string, string | null>, wl: (p: string, label?: string) => string): string {
	const backupOf = new Map(plan.backups.map(b => [b.from, b.to]));
	const rows: string[] = [];
	for (const f of plan.writes) {
		if ((before.get(f.path) ?? null) === null) continue;   // new file
		const b = backupOf.get(f.path);
		rows.push(`| ${wl(f.path)} | ${b ? '覆盖（本地修改过）' : '更新（本地没改过）'} | ${b ? wl(b, '打开备份') : '—'} |`);
	}
	for (const r of plan.renames) rows.push(`| ${wl(r.to)} | 移动/改名（原来在 ${r.from}） | — |`);
	for (const r of plan.archive) rows.push(`| ${wl(r.to)} | Notion 中已删除 → 归档 | — |`);
	for (const c of plan.notionCopies) rows.push(`| ${wl(c.path)} | 冲突：保留本地 | ${wl(c.copy, 'Notion 版本')} |`);
	if (!rows.length) return '- 没有覆盖任何已有文件';
	const shown = rows.slice(0, 300);
	return ['| 文件 | 变化 | 备份 / 另一版本 |', '| --- | --- | --- |', ...shown].join('\n') + (rows.length > shown.length ? `\n\n…另外 ${rows.length - shown.length} 项` : '');
}
