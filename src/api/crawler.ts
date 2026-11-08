/* eslint-disable @typescript-eslint/no-explicit-any */
// Read-only Notion API crawler → Snapshot. Transport is injected (Obsidian's requestUrl in the plugin, fetch in
// scripts); the token lives only inside the transport closure and is never logged.
//
// Backup rules (round 4): nothing is truncated silently. Every API error, every cap that is hit and every
// skipped object is recorded in `snap.errors`, and `snap.complete` is false when anything went wrong, so the
// import report says so at the top and a re-sync never archives pages just because one request failed.
import type { CrawlStats, NBlock, Snapshot } from '../core/types.ts';
import { normId } from '../core/util.ts';

export const NOTION_VERSION = '2026-03-11';

export type Transport = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any; headers?: Record<string, string> }>;

export interface PageRaw { page: any; blocks: NBlock[]; comments?: Record<string, any[]>; /** some children could not be fetched → never reuse */ incomplete?: boolean; fetchedAt?: string }

export interface CrawlOptions {
	rootIds: string[];               // empty → everything the integration can see
	maxPages?: number;               // default: no limit
	maxRowsPerDataSource?: number;   // default: no limit
	rowBodies?: boolean;             // fetch the content of database rows too (default true)
	comments?: 'none' | 'pages' | 'all';   // default 'all' (page + every block; needs the "Read comments" capability)
	templates?: boolean;             // back up database templates (GET /data_sources/{id}/templates), default true
	/** also keep Notion's own Markdown rendering of each page (GET /pages/{id}/markdown, read-only); default false */
	markdown?: boolean;
	onMarkdown?: (id: string, md: any) => Promise<void>;
	/** re-sync: an unchanged page whose Markdown copy is already on disk is not fetched again */
	hasMarkdown?: (id: string) => Promise<boolean>;
	maxDepth?: number;               // default 100 levels of nested blocks
	onProgress?: (msg: string) => void;
	isCancelled?: () => boolean;
	/** called as soon as a page (with its block tree) / database is complete: persist the raw JSON and download
	 *  its files right away (Notion's signed file URLs expire after ~1 hour) */
	onPage?: (id: string, raw: PageRaw) => Promise<void>;
	onDatabase?: (id: string, raw: any) => Promise<void>;
	/** incremental re-sync / resume: previous raw copy of a page when its last_edited_time is unchanged */
	reuse?: (id: string, lastEdited: string) => Promise<PageRaw | undefined>;
	/** round 8, quick re-sync: trust last_edited_time signals (search index + one "recently edited rows" query per
	 *  data source) to reuse unchanged pages AND unchanged databases without re-reading them. Any doubt → full fetch. */
	incremental?: boolean;
	/** previous raw copy of a database ({database, views, data_sources, fetchedAt}) */
	reuseDatabase?: (id: string) => Promise<any | undefined>;
	/** wait between requests in ms (Notion allows ~3 requests / second) */
	minInterval?: number;
	sleep?: (ms: number) => Promise<void>;
	/** a request that hangs (dead connection) is abandoned and retried after this many ms (default 90 s) */
	timeoutMs?: number;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let t: ReturnType<typeof setTimeout>;
	return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const PAGINATE = new Set(['relation', 'people', 'title', 'rich_text', 'rollup']);

export class NotionCrawler {
	private lastCall = 0;
	snap: Snapshot = { roots: [], pages: {}, databases: {}, comments: {}, users: {}, errors: [], complete: true, stats: { pagesFetched: 0, rowsReported: {}, blocks: 0, comments: 0, paginatedProperties: 0, reusedPages: 0 } };
	private queue: { kind: 'page' | 'db'; id: string; row?: any }[] = [];
	private seenPages = new Set<string>();
	private seenDbs = new Set<string>();
	private seenTemplates = new Set<string>();
	private commentsMode: 'none' | 'pages' | 'all';
	private transport: Transport;
	private o: CrawlOptions;
	private sleep: (ms: number) => Promise<void>;
	/** quick mode: search results by id */
	private pageIndex = new Map<string, any>();
	private dsIndex = new Map<string, any>();
	private rowsByDs = new Map<string, any[]>();
	private indexed = false;
	private discoverFailed = false;

	constructor(transport: Transport, o: CrawlOptions) {
		this.transport = transport; this.o = o;
		this.commentsMode = o.comments ?? 'all';
		this.sleep = o.sleep ?? realSleep;
	}

	get errors(): string[] { return this.snap.errors!; }
	get stats(): CrawlStats { return this.snap.stats!; }
	private fail(msg: string) { this.errors.push(msg); this.snap.complete = false; }

	/** Only GET and POST …/query|/search (both read-only) are allowed through. Retries 429 / 5xx / network errors
	 *  with exponential backoff (honouring Retry-After). */
	async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
		if (!(method === 'GET' || (method === 'POST' && (/\/query$/.test(path) || path === '/search')))) throw new Error('read-only crawler: refused ' + method + ' ' + path);
		let last = '';
		for (let attempt = 0; attempt < 8; attempt++) {
			const wait = (this.o.minInterval ?? 340) - (Date.now() - this.lastCall);
			if (wait > 0) await this.sleep(wait);
			this.lastCall = Date.now();
			let r: { status: number; json: any; headers?: Record<string, string> };
			try { r = await withTimeout(this.transport(method, path, body), this.o.timeoutMs ?? 90000); }
			catch (e) { last = 'network: ' + (e as Error).message; await this.sleep(Math.min(60000, 1000 * 2 ** attempt)); continue; }
			if (r.status === 429 || r.status >= 500 || r.status === 409) {
				last = `HTTP ${r.status}`;
				const ra = Number(r.headers?.['retry-after'] ?? r.headers?.['Retry-After']);
				await this.sleep(ra > 0 ? ra * 1000 : Math.min(60000, 1000 * 2 ** attempt));
				continue;
			}
			if (r.status >= 400) return { __error: r.status, code: r.json?.code, message: r.json?.message };
			return r.json ?? { __error: 'empty response' };
		}
		return { __error: 'retries', message: last };
	}

	private async list(path: string, method: 'GET' | 'POST' = 'GET', body: any = {}): Promise<{ results: any[]; error?: any }> {
		const out: any[] = []; let cursor: string | undefined;
		do {
			const sep = path.includes('?') ? '&' : '?';
			const d = method === 'GET'
				? await this.call('GET', `${path}${sep}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`)
				: await this.call('POST', path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
			if (d.__error) return { results: out, error: d };
			out.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : undefined;
		} while (cursor && !this.o.isCancelled?.());
		return { results: out };
	}

	private async children(id: string, where: string): Promise<NBlock[]> {
		const r = await this.list(`/blocks/${id}/children`);
		if (r.error) this.fail(`blocks of ${id} (${where}): ${r.error.__error} ${r.error.message ?? ''} — ${r.results.length} block(s) kept, rest missing`);
		this.stats.blocks += r.results.length;
		return r.results;
	}

	private async tree(id: string, where: string, depth = 0): Promise<NBlock[]> {
		const kids = await this.children(id, where);
		for (const k of kids) {
			if (this.o.isCancelled?.()) break;
			if (k.type === 'child_page') { this.queue.push({ kind: 'page', id: k.id }); continue; }
			if (k.type === 'child_database') { this.queue.push({ kind: 'db', id: k.id }); continue; }
			if (k.type === 'synced_block' && k.synced_block?.synced_from?.block_id) {
				// reference: content lives in the original block (possibly on a page the integration cannot see)
				const before = this.errors.length;
				k.children = await this.tree(k.synced_block.synced_from.block_id, where, depth + 1);
				if (this.errors.length > before && k.has_children) { this.errors.length = before; k.children = await this.tree(k.id, where, depth + 1); }
				continue;
			}
			if (k.has_children) {
				if (depth + 1 > (this.o.maxDepth ?? 100)) { this.fail(`block ${k.id} (${where}): nesting deeper than ${this.o.maxDepth ?? 100} levels – children not fetched`); continue; }
				k.children = await this.tree(k.id, where, depth + 1);
			}
		}
		return kids;
	}

	/** Page objects carry at most 25 items per relation / people / rich text / title / rollup value; fetch the rest. */
	private async completeProperties(page: any): Promise<void> {
		for (const [name, p] of Object.entries<any>(page?.properties || {})) {
			if (!p || !PAGINATE.has(p.type) || p.__completed) continue;
			const v = p[p.type];
			const truncated = p.has_more === true || (Array.isArray(v) && v.length >= 25) || (p.type === 'rollup' && Array.isArray(v?.array) && v.array.length >= 25)
				|| (p.type === 'rollup' && this.relationTruncated(page, p));
			if (!truncated) continue;
			const pid = encodeURIComponent(decodeURIComponent(p.id));
			const all: any[] = []; let cursor: string | undefined; let head: any = null; let err: any = null;
			do {
				const d = await this.call('GET', `/pages/${page.id}/properties/${pid}?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
				if (d.__error) { err = d; break; }
				head ??= d;
				if (d.object !== 'list') { head = d; break; }
				all.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : undefined;
			} while (cursor);
			if (err) { this.fail(`property “${name}” of ${page.id}: ${err.__error} ${err.message ?? ''} – only the first 25 values kept`); continue; }
			const item = head?.property_item || head;
			switch (p.type) {
				case 'relation': p.relation = all.map(r => r.relation).filter(Boolean); break;
				case 'people': p.people = all.map(r => r.people).filter(Boolean); break;
				case 'title': case 'rich_text': p[p.type] = all.map(r => r[p.type]).filter(Boolean); break;
				case 'rollup': {
					const ru = item?.rollup || {};
					if (ru.type === 'array' || (!ru.type && all.length)) p.rollup = { ...p.rollup, type: 'array', array: all.map(itemAsValue) };
					else if (ru.type) p.rollup = { ...p.rollup, ...ru };
					break;
				}
			}
			p.has_more = false; p.__completed = true;
			this.stats.paginatedProperties++;
		}
	}

	private relationTruncated(page: any, rollup: any): boolean {
		const relId = rollup.rollup?.relation_property_id;   // not present in page values; fall back to "any relation truncated"
		return Object.values<any>(page.properties || {}).some(q => q?.type === 'relation' && (q.has_more || (q.__completed && q.relation.length > 25)) && (!relId || q.id === relId));
	}

	private async comments(blockIds: string[]): Promise<Record<string, any[]>> {
		const out: Record<string, any[]> = {};
		for (const id of blockIds) {
			if (this.commentsMode === 'none' || this.o.isCancelled?.()) break;
			const r = await this.list(`/comments?block_id=${id}`);
			if (r.error) {
				if (r.error.__error === 403) {
					this.commentsMode = 'none';
					// loud (top of the report) but does not block re-sync archiving: pages themselves are complete
					this.errors.push('评论没有备份：integration 缺少 “Read comments” 权限（Notion → Settings → Connections → 你的 integration → Capabilities 勾选 Read comments 后重新导入）');
				} else this.fail(`comments of ${id}: ${r.error.__error} ${r.error.message ?? ''}`);
				break;
			}
			if (r.results.length) { out[id] = r.results; this.stats.comments += r.results.length; }
		}
		return out;
	}

	private queueTree(blocks: NBlock[] | undefined): void {
		for (const b of blocks || []) {
			if (b.type === 'child_page') this.queue.push({ kind: 'page', id: b.id });
			else if (b.type === 'child_database') this.queue.push({ kind: 'db', id: b.id });
			this.queueTree(b.children);
		}
	}

	private async page(id: string, row?: any): Promise<void> {
		const key = normId(id);
		if (this.seenPages.has(key)) return;
		if (this.o.maxPages && this.seenPages.size >= this.o.maxPages) { this.fail(`page limit ${this.o.maxPages} reached – page ${id} and later ones not imported`); return; }
		this.seenPages.add(key);
		const page = row ?? (this.o.incremental && this.pageIndex.get(key) ? structuredClone(this.pageIndex.get(key)) : await this.call('GET', `/pages/${id}`));
		if (page.__error) { this.fail(`page ${id}: ${page.__error} ${page.message ?? ''}`); return; }
		if (page.in_trash || page.archived) { this.stats.trashedSkipped = (this.stats.trashedSkipped || 0) + 1; return; }
		await this.completeProperties(page);
		this.stats.pagesFetched++;
		this.o.onProgress?.(`页面 ${this.seenPages.size}: ${titleOf(page)}`);
		let prev = page.last_edited_time ? await this.o.reuse?.(id, page.last_edited_time) : undefined;
		if (prev && this.o.incremental && this.indexed && !this.childrenStillThere(prev.blocks)) prev = undefined;   // a sub-page vanished from search → re-read
		if (prev && this.trusted(page.last_edited_time, prev.fetchedAt) && !hasSyncedRef(prev.blocks)) this.stats.trustedPages = (this.stats.trustedPages || 0) + 1;
		else if (prev && !(row && this.o.rowBodies === false)) {
			// cheap safety net (1 request): the top-level block list must be the same, otherwise re-read the page
			const top = await this.call('GET', `/blocks/${id}/children?page_size=100`);
			const now = (top.results || []).map((b: any) => b.id).join();
			const was = prev.blocks.slice(0, 100).map(b => b.id).join();
			if (top.__error || now !== was) prev = undefined;
		}
		let raw: PageRaw;
		if (prev) {
			this.stats.reusedPages!++;
			this.queueTree(prev.blocks);
			const fresh = this.commentsMode !== 'none' ? await this.comments([id]) : {};
			raw = { page, blocks: prev.blocks, comments: { ...(prev.comments || {}), ...fresh }, fetchedAt: prev.fetchedAt };
		} else {
			const before = this.errors.length;
			const blocks = (row && this.o.rowBodies === false) ? [] : await this.tree(id, titleOf(page) || id);
			const incomplete = this.errors.length > before || !!this.o.isCancelled?.();
			const ids = [id];
			if (this.commentsMode === 'all') walk(blocks, b => { if (b.type !== 'child_page' && b.type !== 'child_database') ids.push(b.id); });
			raw = { page, blocks, comments: this.commentsMode !== 'none' ? await this.comments(ids) : {}, incomplete, fetchedAt: isoUTC(Date.now()) };
		}
		if (!prev || !(await this.o.hasMarkdown?.(id))) await this.markdown(id);
		this.snap.pages[id] = { page, blocks: raw.blocks };
		Object.assign(this.snap.comments!, raw.comments || {});
		await this.o.onPage?.(id, raw);
	}

	private async database(id: string): Promise<void> {
		const key = normId(id);
		if (this.seenDbs.has(key)) return;
		this.seenDbs.add(key);
		if (this.o.incremental && this.indexed && await this.reuseDb(id)) return;
		const fetchedAt = isoUTC(Date.now());
		const database = await this.call('GET', `/databases/${id}`);
		if (database.__error) { this.fail(`database ${id}: ${database.__error} ${database.message ?? ''} (linked to a source the integration cannot see?)`); return; }
		const list = await this.list(`/views?database_id=${id}`);
		if (list.error) this.fail(`views of database ${id}: ${list.error.__error} ${list.error.message ?? ''}`);
		const views: any[] = [];
		for (const v of list.results) {
			const full = await this.call('GET', `/views/${v.id}`);
			if (full.__error) this.fail(`view ${v.id} of ${id}: ${full.__error}`);
			views.push(full);
		}
		const data_sources = [];
		for (const ref of database.data_sources || []) {
			const ds = await this.call('GET', `/data_sources/${ref.id}`);
			if (ds.__error) { this.fail(`data source ${ref.id}: ${ds.__error} ${ds.message ?? ''}`); continue; }
			const isOwner = normId(ds.parent?.database_id) === key;
			const dsKey = normId(ref.id);
			if (!isOwner && this.snap.stats!.rowsReported[dsKey] !== undefined) {
				// linked view of a source that is (being) crawled through its own database: schema only, rows come from the owner
				data_sources.push({ data_source: ds, rows: [] });
				continue;
			}
			const rows: any[] = []; let cursor: string | undefined; let err: any = null;
			do {
				const q = await this.call('POST', `/data_sources/${ref.id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
				if (q.__error) { err = q; break; }
				rows.push(...q.results); cursor = q.has_more ? q.next_cursor : undefined;
				this.o.onProgress?.(`数据库 ${titleOf(ds) || id}: ${rows.length} 行`);
			} while (cursor && rows.length < (this.o.maxRowsPerDataSource ?? Infinity) && !this.o.isCancelled?.());
			if (err) this.fail(`rows of data source ${ref.id}: ${err.__error} ${err.message ?? ''} – ${rows.length} row(s) kept, rest missing`);
			if (cursor) this.fail(`data source ${ref.id}: row limit ${this.o.maxRowsPerDataSource} reached – later rows not imported`);
			for (const r of rows) await this.completeProperties(r);
			this.snap.stats!.rowsReported[dsKey] = Math.max(this.snap.stats!.rowsReported[dsKey] ?? 0, rows.length);
			const templates = this.o.templates === false || this.seenTemplates.has(dsKey) ? undefined : await this.templates(ref.id);
			this.seenTemplates.add(dsKey);
			data_sources.push(templates ? { data_source: ds, rows, templates } : { data_source: ds, rows });
			// template pages: ordinary pages (properties + block tree), placed in <database>/Templates/ by the converter
			for (const t of templates || []) this.queue.push({ kind: 'page', id: t.id });
			// rows are page objects already: their bodies are fetched with the row object (no extra GET /pages)
			for (const r of rows) this.queue.push({ kind: 'page', id: r.id, row: r });
		}
		const snap = { database, views, data_sources, fetchedAt };
		this.snap.databases[id] = snap;
		await this.o.onDatabase?.(id, snap);
	}

	/** quick mode: every sub-page of a reused block tree is still live in search */
	private childrenStillThere(blocks: NBlock[] | undefined): boolean {
		for (const b of blocks || []) {
			if (b.type === 'child_page') { const p = this.pageIndex.get(normId(b.id)); if (!p || p.in_trash || p.archived) return false; }
			if (!this.childrenStillThere(b.children)) return false;
		}
		return true;
	}

	/** edited (minute precision in Notion) safely before the time our copy was fetched → the copy has it */
	private trusted(lastEdited: string | undefined, fetchedAt: string | undefined): boolean {
		if (!this.o.incremental || !lastEdited || !fetchedAt) return false;
		const e = Date.parse(lastEdited), f = Date.parse(fetchedAt);
		return isFinite(e) && isFinite(f) && e + 120000 < f;
	}

	/** Quick re-sync of one database: reuse the raw copy (schema, views, templates, row order) when every signal
	 *  says nothing changed. Signals: every data source in search with the same last_edited_time (and edited before
	 *  our copy was fetched); for data sources whose rows we own: the same set of live rows in search, each with the
	 *  same last_edited_time, AND a filtered query "rows edited since our copy" returning nothing (catches new rows
	 *  that search has not indexed yet). Row objects are taken fresh from search (formula / rollup values current).
	 *  Any missing or odd signal → false (full fetch). */
	private async reuseDb(id: string): Promise<boolean> {
		const prev = await this.o.reuseDatabase?.(id).catch(() => undefined);
		if (!prev?.database || !Array.isArray(prev.data_sources) || !prev.fetchedAt) return false;
		if ((prev.views || []).some((v: any) => v?.__error)) return false;
		if ((prev.database.data_sources || []).length !== prev.data_sources.length) return false;
		const key = normId(id);
		const out: any[] = [];
		for (const d of prev.data_sources) {
			const dsId = normId(d?.data_source?.id);
			const now = this.dsIndex.get(dsId);
			if (!now || now.last_edited_time !== d.data_source.last_edited_time || !this.trusted(now.last_edited_time, prev.fetchedAt)) return false;
			const isOwner = normId(d.data_source.parent?.database_id) === key;
			if (!isOwner && this.snap.stats!.rowsReported[dsId] !== undefined) { out.push({ ...d, rows: [] }); continue; }
			const prevRows: any[] = d.rows || [];
			const tpl = new Set((d.templates || []).map((t: any) => normId(t.id)));
			const live = (this.rowsByDs.get(dsId) || []).filter(r => !r.in_trash && !r.archived && !tpl.has(normId(r.id)));
			if (live.length !== prevRows.length) return false;
			const byId = new Map(live.map(r => [normId(r.id), r]));
			const rows: any[] = [];
			for (const r of prevRows) {
				const n = byId.get(normId(r.id));
				if (!n || n.last_edited_time !== r.last_edited_time || !this.trusted(n.last_edited_time, prev.fetchedAt)) return false;
				rows.push(structuredClone(n));
			}
			const since = isoUTC(Date.parse(prev.fetchedAt) - 180000);
			const q = await this.call('POST', `/data_sources/${d.data_source.id}/query`, { page_size: 1, filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } } });
			if (q.__error || (q.results || []).length) return false;
			out.push({ ...d, data_source: now, rows });
		}
		// commit
		for (const d of out) {
			const dsKey = normId(d.data_source.id);
			const own = normId(d.data_source.parent?.database_id) === key || this.snap.stats!.rowsReported[dsKey] === undefined;
			if (own) this.snap.stats!.rowsReported[dsKey] = Math.max(this.snap.stats!.rowsReported[dsKey] ?? 0, d.rows.length);
			for (const r of d.rows) await this.completeProperties(r);
			if (d.templates) { this.stats.templatesReported = (this.stats.templatesReported || 0) + d.templates.length; this.seenTemplates.add(dsKey); for (const t of d.templates) this.queue.push({ kind: 'page', id: t.id }); }
			for (const r of d.rows) this.queue.push({ kind: 'page', id: r.id, row: r });
		}
		const snap = { database: prev.database, views: prev.views, data_sources: out, fetchedAt: prev.fetchedAt };
		this.snap.databases[id] = snap;
		this.stats.reusedDatabases = (this.stats.reusedDatabases || 0) + 1;
		this.o.onProgress?.(`数据库未变化，沿用备份：${titleOf(prev.database) || id}`);
		await this.o.onDatabase?.(id, snap);
		return true;
	}

	/** Database templates (read-only GET, paginated with start_cursor; the list key is `templates`). */
	private async templates(dsId: string): Promise<{ id: string; name: string; is_default?: boolean }[]> {
		const out: { id: string; name: string; is_default?: boolean }[] = []; let cursor: string | undefined;
		do {
			const d = await this.call('GET', `/data_sources/${dsId}/templates?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
			if (d.__error) { this.fail(`templates of data source ${dsId}: ${d.__error} ${d.message ?? ''} – database templates not backed up`); break; }
			for (const t of d.templates || []) out.push({ id: t.id, name: t.name ?? '', ...(t.is_default ? { is_default: true } : {}) });
			cursor = d.has_more ? d.next_cursor : undefined;
		} while (cursor && !this.o.isCancelled?.());
		this.stats.templatesReported = (this.stats.templatesReported || 0) + out.length;
		return out;
	}

	/** Notion's own Markdown of a page (second, Notion-authored raw copy). Errors are reported, never fatal. */
	private async markdown(id: string): Promise<void> {
		if (!this.o.markdown || !this.o.onMarkdown) return;
		const d = await this.call('GET', `/pages/${id}/markdown?markdown_version=v2`);
		if (d.__error) {
			if (d.__error === 400 && /markdown_version/.test(d.message || '')) { const v1 = await this.call('GET', `/pages/${id}/markdown`); if (!v1.__error) { await this.o.onMarkdown(id, v1); this.stats.markdownCopies = (this.stats.markdownCopies || 0) + 1; return; } }
			this.errors.push(`Notion Markdown copy of ${id}: ${d.__error} ${d.message ?? ''} (block JSON is the primary backup; not affected)`);
			return;
		}
		await this.o.onMarkdown(id, d);
		this.stats.markdownCopies = (this.stats.markdownCopies || 0) + 1;
	}

	private async users(): Promise<void> {
		const r = await this.list('/users');
		for (const u of r.results) this.snap.users![u.id] = u;
		// no "user information" capability → names fall back to what the API embeds (or the id); not a data loss
	}

	/** Every page / data source the integration can see (search is the only complete listing in the API). */
	async discover(): Promise<{ roots: string[]; pages: any[]; dataSources: any[] }> {
		const p = await this.list('/search', 'POST', { filter: { property: 'object', value: 'page' } });
		if (p.error) throw new Error('search failed: ' + p.error.__error + ' ' + (p.error.message ?? ''));
		const d = await this.list('/search', 'POST', { filter: { property: 'object', value: 'data_source' } });
		if (d.error) { this.fail('search for databases failed: ' + d.error.__error); this.discoverFailed = true; }
		const ids = new Set(p.results.map(x => normId(x.id)));
		const roots = p.results.filter(x => !x.in_trash && !x.archived && (x.parent?.type === 'workspace' || (x.parent?.type === 'page_id' && !ids.has(normId(x.parent.page_id))))).map(x => x.id);
		this.stats.searchPages = p.results.filter(x => !x.in_trash && !x.archived).length;
		this.stats.searchDataSources = d.results.length;
		return { roots, pages: p.results, dataSources: d.results };
	}

	async run(): Promise<Snapshot> {
		await this.users();
		let extraPages: any[] = []; let extraDs: any[] = [];
		if (this.o.rootIds.length && !this.o.incremental) this.snap.roots = this.o.rootIds;
		else {
			const found = await this.discover();
			if (this.o.rootIds.length) this.snap.roots = this.o.rootIds;
			else { this.snap.roots = found.roots; extraPages = found.pages; extraDs = found.dataSources; }
			if (this.o.incremental && !this.discoverFailed) {
				for (const pg of found.pages) {
					this.pageIndex.set(normId(pg.id), pg);
					const ds = pg.parent?.data_source_id ?? (pg.parent?.type === 'database_id' ? pg.parent.database_id : undefined);
					if (ds) { const k = normId(ds); if (!this.rowsByDs.has(k)) this.rowsByDs.set(k, []); this.rowsByDs.get(k)!.push(pg); }
				}
				for (const d of found.dataSources) this.dsIndex.set(normId(d.id), d);
				this.indexed = true;
			}
		}
		for (const r of this.snap.roots) this.queue.push({ kind: 'page', id: r });
		const drain = async () => {
			while (this.queue.length && !this.o.isCancelled?.()) {
				const job = this.queue.shift()!;
				if (job.kind === 'page') await this.page(job.id, job.row); else await this.database(job.id);
			}
		};
		await drain();
		// whole-workspace mode: anything search shows that the tree walk did not reach (pages shared on their own,
		// pages inside blocks we could not open, databases whose parent page is not shared…)
		for (const ds of extraDs) { const db = ds.parent?.database_id; if (db && !this.seenDbs.has(normId(db))) this.queue.push({ kind: 'db', id: db }); }
		await drain();
		for (const pg of extraPages) if (!this.seenPages.has(normId(pg.id)) && !pg.in_trash && !pg.archived) this.queue.push({ kind: 'page', id: pg.id, row: pg.parent?.type === 'data_source_id' || pg.parent?.type === 'database_id' ? pg : undefined });
		await drain();
		if (this.o.isCancelled?.()) { this.snap.complete = false; this.errors.push('导入被取消'); }
		return this.snap;
	}
}

/** A property item from /pages/{id}/properties/{prop} → the value shape used inside page objects. */
function itemAsValue(it: any): any {
	if (!it?.type) return it;
	if (it.type === 'title' || it.type === 'rich_text') return { type: it.type, [it.type]: [it[it.type]] };
	if (it.type === 'relation') return { type: 'relation', relation: [it.relation] };
	if (it.type === 'people') return { type: 'people', people: [it.people] };
	return it;
}

/** strict ISO-8601 UTC (the API filter needs it; never depends on Date#toISOString overrides) */
export function isoUTC(ms: number): string {
	const d = new Date(ms); const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}Z`;
}

/** a synced-block reference shows content from another block: its page's last_edited_time does not move when
 *  the original changes → never trusted */
function hasSyncedRef(blocks: NBlock[] | undefined): boolean {
	for (const b of blocks || []) { if (b.type === 'synced_block' && (b as any).synced_block?.synced_from) return true; if (hasSyncedRef(b.children)) return true; }
	return false;
}

function walk(blocks: NBlock[] | undefined, fn: (b: NBlock) => void) { for (const b of blocks || []) { fn(b); walk(b.children, fn); } }

function titleOf(o: any): string {
	if (Array.isArray(o?.title)) return o.title.map((t: any) => t.plain_text).join('');
	for (const v of Object.values<any>(o?.properties || {})) if (v?.type === 'title') return (v.title || []).map((t: any) => t.plain_text).join('');
	return '';
}

/** Accepts a page URL, a 32-hex id, or a dashed uuid. */
export function parseNotionId(s: string): string | null {
	const m = s.trim().match(/([0-9a-f]{32})(?:\?|$|#)/i) || s.trim().match(/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i);
	if (!m) return null;
	const h = m[1].replace(/-/g, '');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
