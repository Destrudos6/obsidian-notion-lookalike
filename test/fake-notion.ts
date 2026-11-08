/* eslint-disable @typescript-eslint/no-explicit-any */
// In-memory Notion API (shapes from the API reference, 2026-03-11) for crawler / pipeline tests.
import type { Transport } from '../src/api/crawler.ts';
import type { VaultIO, Fetcher } from '../src/pipeline.ts';

export const ann = (o: any = {}) => ({ bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default', ...o });
export const rt = (s: string, a: any = {}) => [{ type: 'text', text: { content: s, link: null }, annotations: ann(a), plain_text: s, href: null }];
let n = 0;
export const uid = () => { n++; const h = n.toString(16).padStart(12, '0'); return `00000000-0000-4000-8000-${h}`; };

export class FakeNotion {
	pages: Record<string, any> = {};
	children: Record<string, any[]> = {};
	databases: Record<string, any> = {};
	dataSources: Record<string, any> = {};
	rows: Record<string, any[]> = {};
	views: Record<string, any[]> = {};
	comments: Record<string, any[]> = {};
	propItems: Record<string, any[]> = {};       // `${pageId}/${propId}` → property items
	templates: Record<string, { id: string; name: string; is_default?: boolean }[]> = {};   // data source id → templates
	commentsForbidden = false;
	calls: string[] = [];
	failOnce = new Map<string, number | 'throw'>();   // path prefix → status to return once (or throw)
	edited = '2026-11-01T00:00:00.000Z';

	page(title: string, parent: any, extra: any = {}): any {
		const id = uid();
		const p = { object: 'page', id, created_time: '2026-11-01T02:00:00.000Z', last_edited_time: this.edited, parent, in_trash: false, archived: false, icon: null, cover: null, url: `https://www.notion.so/${id.replace(/-/g, '')}`,
			properties: { title: { id: 'title', type: 'title', title: rt(title) } }, ...extra };
		this.pages[id] = p; this.children[id] = this.children[id] || [];
		return p;
	}
	block(parentId: string, type: string, data: any = {}, kids?: any[]): any {
		const b = { object: 'block', id: uid(), type, [type]: data, has_children: !!kids?.length, parent: { type: 'block_id', block_id: parentId } };
		(this.children[parentId] ||= []).push(b);
		if (kids) this.children[b.id] = kids.map(k => ({ ...k, parent: { type: 'block_id', block_id: b.id } }));
		return b;
	}
	childPage(parentPageId: string, title: string, inBlock?: string): any {
		const p = this.page(title, inBlock ? { type: 'block_id', block_id: inBlock } : { type: 'page_id', page_id: parentPageId });
		const b = { object: 'block', id: p.id, type: 'child_page', child_page: { title }, has_children: false };
		(this.children[inBlock || parentPageId] ||= []).push(b);
		return p;
	}
	database(parentPageId: string, title: string, props: any, rows: any[][] = []): { db: any; ds: any } {
		const dbId = uid(), dsId = uid();
		const ds = { object: 'data_source', id: dsId, last_edited_time: this.edited, title: rt(title), parent: { type: 'database_id', database_id: dbId }, properties: props };
		const db = { object: 'database', id: dbId, title: rt(title), parent: { type: 'page_id', page_id: parentPageId }, is_inline: true, data_sources: [{ id: dsId, name: title }] };
		this.databases[dbId] = db; this.dataSources[dsId] = ds; this.rows[dsId] = []; this.views[dbId] = [];
		(this.children[parentPageId] ||= []).push({ object: 'block', id: dbId, type: 'child_database', child_database: { title }, has_children: false });
		for (const r of rows) this.addRow(dsId, r[0], r[1] || {});
		return { db, ds };
	}
	/** a database template: a page whose parent is the data source but that is not returned by query */
	addTemplate(dsId: string, name: string, props: any = {}, isDefault = false): any {
		const p = this.page(name, { type: 'data_source_id', data_source_id: dsId });
		Object.assign(p.properties, props);
		(this.templates[dsId] ||= []).push({ id: p.id, name, ...(isDefault ? { is_default: true } : {}) });
		return p;
	}
	addRow(dsId: string, title: string, props: any): any {
		const p = this.page(title, { type: 'data_source_id', data_source_id: dsId });
		Object.assign(p.properties, props);
		this.rows[dsId].push(p);
		return p;
	}

	private paginate(list: any[], url: URL): any {
		const size = Number(url.searchParams.get('page_size') || 100);
		const start = Number(url.searchParams.get('start_cursor') || 0);
		const results = list.slice(start, start + size);
		const more = start + size < list.length;
		return { object: 'list', results, has_more: more, next_cursor: more ? String(start + size) : null };
	}

	transport: Transport = async (method, path, body: any) => {
		this.calls.push(method + ' ' + path);
		for (const [prefix, st] of this.failOnce) if (path.startsWith(prefix)) {
			this.failOnce.delete(prefix);
			if (st === 'throw') throw new Error('ECONNRESET');
			return { status: st, json: { message: 'fail' }, headers: st === 429 ? { 'retry-after': '1' } : {} };
		}
		const url = new URL('https://x' + path);
		const seg = url.pathname.split('/').filter(Boolean);
		const ok = (json: any) => ({ status: 200, json });
		const nf = { status: 404, json: { object: 'error', message: 'not found' } };
		if (method === 'POST' && path === '/search') {
			const kind = body?.filter?.value;
			const all = kind === 'data_source' ? Object.values(this.dataSources) : Object.values(this.pages);
			const u = new URL('https://x/?page_size=' + (body.page_size || 100) + (body.start_cursor ? '&start_cursor=' + body.start_cursor : ''));
			return ok(this.paginate(all, u));
		}
		if (seg[0] === 'users') return ok(this.paginate([{ object: 'user', id: 'u1', name: 'Me', type: 'person' }], url));
		if (seg[0] === 'pages' && seg[2] === 'properties') {
			const items = this.propItems[`${seg[1]}/${decodeURIComponent(seg[3])}`];
			if (!items) return nf;
			return ok({ ...this.paginate(items, url), type: 'property_item', property_item: { id: seg[3], type: items[0]?.type, [items[0]?.type]: {} } });
		}
		if (seg[0] === 'pages' && seg[2] === 'markdown') return this.pages[seg[1]] ? ok({ object: 'page_markdown', id: seg[1], markdown: `# ${this.pages[seg[1]].properties.title.title[0]?.plain_text ?? ''}\n`, truncated: false, unknown_block_ids: [] }) : nf;
		if (seg[0] === 'pages') return this.pages[seg[1]] ? ok(this.pages[seg[1]]) : nf;
		if (seg[0] === 'blocks' && seg[2] === 'children') return this.children[seg[1]] ? ok(this.paginate(this.children[seg[1]], url)) : nf;
		if (seg[0] === 'comments') {
			if (this.commentsForbidden) return { status: 403, json: { message: 'Insufficient permissions' } };
			return ok(this.paginate(this.comments[url.searchParams.get('block_id')!] || [], url));
		}
		if (seg[0] === 'databases') return this.databases[seg[1]] ? ok(this.databases[seg[1]]) : nf;
		if (seg[0] === 'views' && !seg[1]) return ok(this.paginate((this.views[url.searchParams.get('database_id')!] || []).map(v => ({ id: v.id })), url));
		if (seg[0] === 'views') { for (const vs of Object.values(this.views)) { const v = vs.find(x => x.id === seg[1]); if (v) return ok(v); } return nf; }
		if (seg[0] === 'data_sources' && seg[2] === 'query') {
			const u = new URL('https://x/?page_size=' + (body?.page_size || 100) + (body?.start_cursor ? '&start_cursor=' + body.start_cursor : ''));
			let rows = this.rows[seg[1]] || [];
			const tf = body?.filter?.timestamp === 'last_edited_time' ? body.filter.last_edited_time?.on_or_after : undefined;
			if (tf) rows = rows.filter(r => Date.parse(r.last_edited_time) >= Date.parse(tf));
			return ok(this.paginate(rows, u));
		}
		if (seg[0] === 'data_sources' && seg[2] === 'templates') {
			if (method !== 'GET') return { status: 400, json: { message: 'GET only' } };
			const all = this.templates[seg[1]] || [];
			const p = this.paginate(all, url);
			return ok({ templates: p.results, has_more: p.has_more, next_cursor: p.next_cursor });
		}
		if (seg[0] === 'data_sources') return this.dataSources[seg[1]] ? ok(this.dataSources[seg[1]]) : nf;
		return nf;
	};
}

/** In-memory vault. */
export class MemVault implements VaultIO {
	files = new Map<string, string | ArrayBuffer>();
	renames: [string, string][] = [];
	async read(p: string) { const v = this.files.get(p); return typeof v === 'string' ? v : v ? '[binary]' : null; }
	async write(p: string, c: string) { this.files.set(p, c); }
	async writeBinary(p: string, d: ArrayBuffer) { this.files.set(p, d); }
	async size(p: string) { const v = this.files.get(p); return v === undefined ? -1 : typeof v === 'string' ? v.length : v.byteLength; }
	async rename(a: string, b: string) { const v = this.files.get(a); if (v === undefined) return; this.files.delete(a); this.files.set(b, v); this.renames.push([a, b]); }
	async copy(a: string, b: string) { const v = this.files.get(a); if (v !== undefined) this.files.set(b, v); }
	async list(folder: string) { return [...this.files.keys()].filter(k => k.startsWith(folder + '/') && !k.slice(folder.length + 1).includes('/')); }
	async remove(p: string) { this.files.delete(p); }
	async listAll() { return [...this.files.keys()].filter(k => /\.(md|base)$/.test(k)); }
	removedDirs: string[] = [];
	async removeEmptyDir(d: string) { if ([...this.files.keys()].some(k => k.startsWith(d + '/'))) return false; this.removedDirs.push(d); return true; }
}

export const okFetcher = (fail: RegExp | null = null): Fetcher & { calls: string[] } => {
	const calls: string[] = [];
	const f = (async (url: string) => { calls.push(url); if (fail && fail.test(url)) return { status: 403, data: new ArrayBuffer(0) }; return { status: 200, data: new TextEncoder().encode('img:' + url).buffer as ArrayBuffer, contentType: 'image/png' }; }) as Fetcher & { calls: string[] };
	f.calls = calls;
	return f;
};
