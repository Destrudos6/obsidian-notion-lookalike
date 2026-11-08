/* eslint-disable @typescript-eslint/no-explicit-any */
// Snapshot (Notion API objects) → vault files. Pure: no Obsidian, no network. Used by the plugin and tests.
import { renderBlocks } from './blocks.ts';
import { walkBlocks } from './audit.ts';
import { richText } from './richtext.ts';
import { Ctx, iconValue } from './context.ts';
import { compileFormulas, type FormulaReportEntry, type LiveProp } from './formula.ts';
import { rowFrontmatter } from './properties.ts';
import { propKey } from './properties.ts';
import type { ConvertOptions, ConvertResult, DataSourceSnap, DatabaseSnap, NBlock, NotionObj, OutFile, Snapshot } from './types.ts';
import { DEFAULT_OPTIONS } from './types.ts';
import { dbTitle, isoToLocal, joinPath, normId, notionUrl, pageTitle, plain, sanitizeFileName } from './util.ts';
import { isPercent, pctFormula, pctFormulaName, ORDERED_TYPES, ordFormula, ordFormulaName, columnKey, convertView, optionsOf, pillFormula, pillFormulaName, schemaOf, type Schema } from './views.ts';
import { frontmatter, toYaml } from './yaml.ts';

interface PlannedPage { id: string; path: string; folder: string; childFolder: string; page: NotionObj; blocks: NBlock[]; row?: { dsId: string }; template?: { dsId: string; name: string; isDefault: boolean } }
interface PlannedDs { id: string; name: string; folder: string; basePath: string; snap: DataSourceSnap; sourceDb?: DatabaseSnap; icon?: string }

export class Converter {
	ctx: Ctx;
	private used = new Set<string>();
	private pages = new Map<string, PlannedPage>();
	private dss = new Map<string, PlannedDs>();
	private files: OutFile[] = [];

	private snap: Snapshot;
	/** ids the user chose "以后不再同步" for (normalized) + everything below them that was skipped */
	private ignore = new Set<string>();
	private skippedIds = new Set<string>();
	private skipped: NonNullable<ConvertResult['skipped']> = [];
	constructor(snap: Snapshot, opts: Partial<ConvertOptions> = {}) {
		this.snap = snap;
		this.ctx = new Ctx({ ...DEFAULT_OPTIONS, ...opts });
		for (const id of opts.ignore || []) this.ignore.add(normId(id));
		// paths the user moved / renamed imported items to are taken: nothing else may be planned there
		for (const p of Object.values(opts.relocate || {})) { this.used.add(p.toLowerCase()); if (p.endsWith('.md')) this.used.add(p.slice(0, -3).toLowerCase()); }
	}

	private skip(id: string, title: string, kind: 'page' | 'database' | 'row' | 'template'): void {
		const k = normId(id);
		if (this.skippedIds.has(k)) return;
		this.skippedIds.add(k);
		this.skipped.push({ id: k, title, kind });
	}

	/** a page that is skipped takes its sub-pages and inline databases with it (they are not re-homed elsewhere) */
	private skipTree(blocks: NBlock[] | undefined): void {
		walkBlocks(blocks, b => {
			if (b.type === 'child_page') { const ps = this.pageSnap(b.id); this.skip(b.id, b.child_page?.title || '', 'page'); this.skipTree(ps?.blocks); }
			else if (b.type === 'child_database') {
				const d = this.db(b.id);
				for (const ds of d?.data_sources || []) if (normId(ds.data_source?.parent?.database_id) === normId(b.id)) this.skipDs(normId(ds.data_source?.id));
			}
		});
	}

	private skipDs(dsId: string): void {
		const info = this.dsAll.get(dsId);
		if (!info || this.skippedIds.has(dsId)) return;
		this.skip(dsId, plain(info.snap.data_source?.title) || dbTitle(info.owner?.database), 'database');
		for (const row of info.snap.rows) { this.skip(row.id, pageTitle(row), 'row'); this.skipTree(this.pageSnap(row.id)?.blocks); }
		for (const t of this.dsTemplates.get(dsId) || []) this.skip(t.id, t.name || '', 'template');
	}

	private isIgnoredDs(dsId: string, info?: { owner?: DatabaseSnap }): boolean {
		return this.ignore.has(dsId) || (!!info?.owner && this.ignore.has(normId(info.owner.database.id)));
	}

	/** where the user keeps this item locally (moved / renamed in the vault), if anywhere else than planned */
	private relocated(id: string): string | undefined {
		return this.ctx.opts.relocate?.[normId(id)];
	}

	private unique(folder: string, name: string, ext: string): string {
		let n = 1; let p = joinPath(folder, `${name}${ext}`);
		while (this.used.has(p.toLowerCase())) { n++; p = joinPath(folder, `${name} (${n})${ext}`); }
		this.used.add(p.toLowerCase());
		return p;
	}

	/** Sub-pages of "X (2).md" go to "X (2)/" – never into the folder of another page / database with the same title. */
	private childFolderOf(mdPath: string): string {
		const stem = mdPath.replace(/\.md$/, '');
		this.used.add(stem.toLowerCase());
		return stem;
	}

	private db(id: string): DatabaseSnap | undefined {
		const want = normId(id);
		for (const [k, v] of Object.entries(this.snap.databases)) if (normId(k) === want) return v;
		return undefined;
	}
	private pageSnap(id: string) {
		const want = normId(id);
		for (const [k, v] of Object.entries(this.snap.pages)) if (normId(k) === want) return v;
		return undefined;
	}

	/** all data sources in the snapshot, keyed by ds id, with the database that owns it (if crawled) */
	private allDataSources(): Map<string, { snap: DataSourceSnap; owner?: DatabaseSnap; any: DatabaseSnap }> {
		const m = new Map<string, { snap: DataSourceSnap; owner?: DatabaseSnap; any: DatabaseSnap }>();
		for (const d of Object.values(this.snap.databases)) {
			for (const ds of d.data_sources || []) {
				const id = normId(ds.data_source?.id);
				if (!id) continue;
				const isOwner = normId(ds.data_source?.parent?.database_id) === normId(d.database?.id);
				const cur = m.get(id);
				if (!cur) m.set(id, { snap: ds, owner: isOwner ? d : undefined, any: d });
				else if (isOwner) { cur.owner = d; if (ds.rows.length > cur.snap.rows.length) cur.snap = ds; }
				else if (ds.rows.length > cur.snap.rows.length) cur.snap = { ...ds, data_source: cur.snap.data_source };
			}
		}
		return m;
	}

	// ---------- pass 1: plan paths ----------
	private planPage(id: string, folder: string): void {
		const key = normId(id);
		if (this.pages.has(key)) return;
		const ps = this.pageSnap(id);
		if (!ps || ps.page?.__error) return;
		if (this.skippedIds.has(key)) return;
		if (this.ignore.has(key)) { this.skip(key, pageTitle(ps.page), 'page'); this.skipTree(ps.blocks); return; }
		const title = sanitizeFileName(pageTitle(ps.page));
		const path = this.relocated(key) ?? this.unique(folder, title, '.md');
		const childFolder = this.childFolderOf(path);
		this.pages.set(key, { id, path, folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', childFolder, page: ps.page, blocks: ps.blocks });
		this.ctx.links.set(key, { path: path.replace(/\.md$/, ''), title: pageTitle(ps.page) || 'Untitled', kind: 'page', icon: iconValue(ps.page, this.ctx) });
		this.scanBlocks(ps.blocks, childFolder);
	}

	private scanBlocks(blocks: NBlock[] | undefined, folder: string): void {
		for (const b of blocks || []) {
			if (b.type === 'child_page') this.planPage(b.id, folder);
			else if (b.type === 'child_database') this.planDatabaseBlock(b.id, folder);
			if (b.children) this.scanBlocks(b.children, folder);
		}
	}

	private dsAll = new Map<string, { snap: DataSourceSnap; owner?: DatabaseSnap; any: DatabaseSnap }>();
	/** data source id → its templates (GET /data_sources/{id}/templates), from any crawled copy of the data source */
	private dsTemplates = new Map<string, { id: string; name: string; is_default?: boolean }[]>();
	/** data source id → template notes written (for the database's template list) */
	private templatesOf = new Map<string, PlannedPage[]>();

	private planDatabaseBlock(dbId: string, folder: string): void {
		const d = this.db(dbId);
		if (!d || d.database?.__error) return;
		for (const ds of d.data_sources || []) {
			const id = normId(ds.data_source?.id);
			const isOwner = normId(ds.data_source?.parent?.database_id) === normId(dbId);
			if (isOwner) this.planDs(id, folder);
		}
	}

	private planDs(dsId: string, folder: string): void {
		if (this.dss.has(dsId) || this.skippedIds.has(dsId)) return;
		const info = this.dsAll.get(dsId);
		if (!info) return;
		if (this.isIgnoredDs(dsId, info)) { this.skipDs(dsId); return; }
		const dsObj = info.snap.data_source;
		const t = dbTitle(info.owner?.database);
		const name = sanitizeFileName(plain(dsObj?.title) || (t && t !== 'Untitled' ? t : '') || 'Database');
		// moved / renamed locally: keep the user's place. The rows folder moves with the .base only when the
		// "X/X.base" layout is intact (otherwise rows stay where the importer keeps them).
		const rel = this.relocated(dsId);
		const relDir = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
		const relKeepsFolder = !!rel && relDir.split('/').pop() === rel.slice(rel.lastIndexOf('/') + 1).replace(/\.base$/, '');
		const dsFolder = relKeepsFolder ? relDir : this.unique(folder, name, '');
		if (relKeepsFolder) this.used.add(dsFolder.toLowerCase());
		const basePath = rel ?? joinPath(dsFolder, `${name}.base`);
		this.used.add(basePath.toLowerCase());
		const icon = iconValue(dsObj, this.ctx) || iconValue(info.owner?.database, this.ctx);
		this.dss.set(dsId, { id: dsId, name, folder: dsFolder, basePath, snap: info.snap, sourceDb: info.owner, icon });
		this.ctx.links.set(dsId, { path: basePath, title: plain(dsObj?.title) || name, kind: 'base', icon });
		if (info.owner) this.ctx.links.set(normId(info.owner.database.id), { path: basePath, title: plain(dsObj?.title) || name, kind: 'base', icon });
		for (const row of info.snap.rows) {
			const rid = normId(row.id);
			if (this.pages.has(rid)) continue;
			if (this.ignore.has(rid)) { this.skip(rid, pageTitle(row), 'row'); this.skipTree(this.pageSnap(row.id)?.blocks); continue; }
			const title = sanitizeFileName(pageTitle(row));
			const path = this.relocated(rid) ?? this.unique(dsFolder, title, '.md');
			const body = this.pageSnap(row.id);
			const childFolder = this.childFolderOf(path);
			this.pages.set(rid, { id: row.id, path, folder: dsFolder, childFolder, page: row, blocks: body?.blocks || [], row: { dsId } });
			this.ctx.links.set(rid, { path: path.replace(/\.md$/, ''), title: pageTitle(row) || 'Untitled', kind: 'page', icon: iconValue(row, this.ctx) });
		}
		// database templates → "<database>/Templates/<template>.md" (a sub-folder, so they are not rows of the base)
		for (const t of this.dsTemplates.get(dsId) || []) {
			const tid = normId(t.id);
			const ps = this.pageSnap(t.id);
			if (this.pages.has(tid) || !ps?.page || ps.page.__error) continue;
			const tFolder = joinPath(dsFolder, 'Templates');
			const path = this.relocated(tid) ?? this.unique(tFolder, sanitizeFileName(t.name || pageTitle(ps.page) || 'Template'), '.md');
			const planned: PlannedPage = { id: t.id, path, folder: tFolder, childFolder: this.childFolderOf(path), page: ps.page, blocks: ps.blocks, template: { dsId, name: t.name || pageTitle(ps.page), isDefault: !!t.is_default } };
			this.pages.set(tid, planned);
			this.ctx.links.set(tid, { path: path.replace(/\.md$/, ''), title: t.name || pageTitle(ps.page) || 'Template', kind: 'page', icon: iconValue(ps.page, this.ctx) });
			(this.templatesOf.get(dsId) || this.templatesOf.set(dsId, []).get(dsId)!).push(planned);
		}
	}

	// ---------- pass 2: render ----------
	run(): ConvertResult {
		const root = this.ctx.opts.targetFolder;
		this.dsAll = this.allDataSources();
		for (const d of Object.values(this.snap.databases)) for (const ds of d.data_sources || []) {
			const id = normId(ds.data_source?.id);
			if (id && ds.templates?.length && !this.dsTemplates.has(id)) this.dsTemplates.set(id, ds.templates);
		}
		this.ctx.users = this.snap.users || {};
		for (const r of this.snap.roots) this.planPage(r, root);
		// row bodies may contain child pages / databases
		for (const p of [...this.pages.values()]) if (p.row) this.scanBlocks(p.blocks, p.childFolder);
		// data sources only reachable through linked views (the database's own page is not shared with the
		// integration) → one generated page "未归类的数据库" that explains why and holds them
		const lonely = [...this.dsAll.keys()].filter(id => !this.dss.has(id) && !this.skippedIds.has(id));
		let holder: { note: string; folder: string } | null = null;
		if (lonely.length) {
			const note = this.relocated(HOLDER_ID) ?? this.unique(root, UNSORTED_DB_FOLDER, '.md');
			holder = { note, folder: this.childFolderOf(note) };
			for (const dsId of lonely) this.planDs(dsId, holder.folder);
		}
		for (const p of [...this.pages.values()]) if (p.row || p.template) this.scanBlocks(p.blocks, p.childFolder);
		this.placeOrphans(root);

		this.prepareDbRenderers();
		for (const ds of this.dss.values()) this.files.push({ path: ds.basePath, content: this.baseFile(ds) });
		for (const p of this.pages.values()) this.files.push({ path: p.path, content: this.renderPage(p) });

		this.ctx.audit.commentsRendered = this.renderedComments.size;
		const idPaths: Record<string, string> = {};
		for (const [k, p] of this.pages) idPaths[k] = p.path;
		for (const ds of this.dss.values()) idPaths[ds.id] = ds.basePath;
		if (holder) {
			const inHolder = lonely.map(id => this.dss.get(id)).filter((d): d is PlannedDs => !!d);
			if (inHolder.length) { this.files.push({ path: holder.note, content: holderNote(inHolder) }); idPaths[HOLDER_ID] = holder.note; }
		}
		const formulaReport = [...this.compiled.values()].flatMap(c => c.report);
		for (const e of formulaReport) if (!e.live) this.ctx.warn(`${e.db} › ${e.property}: static value (${e.reason})`);
		return { files: this.files, assets: [...this.ctx.assets.values()], warnings: this.ctx.warnings, colors: this.ctx.colors, formulaReport,
			baseIcons: Object.fromEntries([...this.dss.values()].filter(d => d.icon).map(d => [d.basePath, d.icon!])), audit: this.ctx.audit, idPaths, skipped: this.skipped };
	}

	/** Pages in the snapshot that no child_page block / database led to (shared individually, inside a block the
	 *  crawl could not open, rows of a database without access…). Placed under their parent page when that was
	 *  imported, otherwise in "_Unsorted" – never left out. */
	private placeOrphans(root: string): void {
		const owner = new Map<string, string>();   // block id → page key
		const index = () => { for (const [k, p] of this.pages) walkBlocks(p.blocks, b => { if (!owner.has(normId(b.id))) owner.set(normId(b.id), k); }); };
		index();
		const pending = () => Object.entries(this.snap.pages).filter(([k, v]) => !this.pages.has(normId(k)) && !this.skippedIds.has(normId(k)) && v.page && !v.page.__error);
		for (let pass = 0; pass < 20; pass++) {
			let progress = false;
			for (const [id, ps] of pending()) {
				const par = ps.page.parent || {};
				const pid = par.type === 'page_id' ? normId(par.page_id) : par.type === 'block_id' ? owner.get(normId(par.block_id)) : undefined;
				// below a page / database the user chose not to sync → skipped with it
				const pds = par.type === 'data_source_id' ? normId(par.data_source_id) : par.type === 'database_id' ? normId(par.database_id) : undefined;
				if ((pid && this.skippedIds.has(pid)) || (pds && (this.skippedIds.has(pds) || this.ignore.has(pds))) || this.ignore.has(normId(id))) {
					this.skip(id, pageTitle(ps.page), pds ? 'row' : 'page'); this.skipTree(ps.blocks); progress = true; continue;
				}
				const host = pid ? this.pages.get(pid) : undefined;
				if (par.type === 'workspace') this.planPage(id, root);
				else if (host) this.planPage(id, host.childFolder);
				else continue;
				this.ctx.audit.orphansPlaced++; progress = true;
			}
			if (!progress) break;
			index();
		}
		for (const [id] of pending()) { this.planPage(id, joinPath(root, '_Unsorted')); this.ctx.audit.orphansPlaced++; }
		if (this.ctx.audit.orphansPlaced) this.ctx.warn(`${this.ctx.audit.orphansPlaced} page(s) were not linked from any imported page – placed under their parent or in _Unsorted`);
	}

	private compiled = new Map<string, { schema: Schema; live: Map<string, LiveProp>; report: FormulaReportEntry[] }>();

	/** Schema of a data source with live-formula keys attached (compiled once per data source). */
	private schemaFor(ds: PlannedDs): Schema {
		const hit = this.compiled.get(ds.id);
		if (hit) return hit.schema;
		const schema = schemaOf(ds.snap.data_source);
		const look = { schema: (id: string) => this.rawSchema(id) };
		// chart / calendar views read live values through Bases (entry.getValue), so nothing has to stay static
		const { live, report } = compileFormulas(ds.name, schema, look, {});
		for (const [name, lp] of live) { const q = schema.byName.get(name); if (q) { q.liveKey = lp.key; q.liveDisplay = lp.display; } }
		this.compiled.set(ds.id, { schema, live, report });
		return schema;
	}
	private liveOf(dsId: string): Map<string, LiveProp> { const ds = this.dss.get(dsId); if (ds) this.schemaFor(ds); return this.compiled.get(dsId)?.live || new Map(); }

	/** plain schema of any data source (by data source id or database id) – for rollup targets */
	private rawSchema(id: string): Schema | undefined {
		const n = normId(id);
		const hit = this.dsAll.get(n);
		if (hit) return schemaOf(hit.snap.data_source);
		const d = this.db(id);
		const first = d?.data_sources?.[0]?.data_source;
		return first ? schemaOf(first) : undefined;
	}

	private hasCovers(ds: PlannedDs): boolean { return ds.snap.rows.some((r: any) => !!r.cover); }

	private baseHeader(ds: PlannedDs, schema: Schema): Record<string, unknown> {
		const pills = this.ctx.opts.coloredPills;
		const formulas: Record<string, string> = {};
		const properties: Record<string, unknown> = { 'file.name': { displayName: schema.titleName } };
		for (const p of schema.ordered) {
			if (p.type === 'title' || p.type === 'button') continue;
			const opts = optionsOf(p);
			if (opts.length) {
				const colorMap: Record<string, string> = this.ctx.colors[propKey(p.name)] || {};
				for (const o of opts) colorMap[o.name] = o.color || 'default';
				this.ctx.colors[propKey(p.name)] = colorMap;
			}
			if (pills && opts.length && ['select', 'multi_select', 'status'].includes(p.type)) {
				formulas[pillFormulaName(p)] = pillFormula(p);
				properties[`formula.${pillFormulaName(p)}`] = { displayName: p.name };
			}
			if (ORDERED_TYPES.has(p.type) && opts.length) formulas[ordFormulaName(p)] = ordFormula(p);
			if (p.liveKey) {
				// Notion formula / rollup → live Bases formula (no static copy in the notes)
				const lp = this.compiled.get(ds.id)!.live.get(p.name)!;
				formulas[lp.key] = lp.expr;
				properties[`formula.${lp.key}`] = { displayName: p.name };
				if (lp.display) { formulas[lp.display] = lp.displayExpr!; properties[`formula.${lp.display}`] = { displayName: p.name }; }
				continue;
			}
			if (isPercent(p)) { formulas[pctFormulaName(p)] = pctFormula(p); properties[`formula.${pctFormulaName(p)}`] = { displayName: p.name }; }
			properties[propKey(p.name)] = { displayName: p.name };
		}
		const out: Record<string, unknown> = {
			filters: { and: [`file.folder == ${JSON.stringify(ds.folder)}`, 'file.ext == "md"'] },
		};
		if (Object.keys(formulas).length) out.formulas = formulas;
		out.properties = properties;
		return out;
	}

	/** Bases views of one Notion database block, in Notion's tab order (form views are dropped). */
	private viewsFor(dbSnap: DatabaseSnap | undefined, ds: PlannedDs, schema: Schema) {
		const views: Record<string, unknown>[] = [];
		const names = new Set<string>();
		for (const v of dbSnap?.views || []) {
			if (v.__error) continue;
			if (v.data_source_id && normId(v.data_source_id) !== ds.id) continue;
			const bv = convertView(v, { schema, pills: this.ctx.opts.coloredPills, hasCovers: this.hasCovers(ds), colors: this.ctx.colors, folder: ds.folder }, this.ctx);
			if (!bv) continue;
			// Bases selects views by name → names must be unique within one base
			let name = String(bv.name || 'View'); let n = 1;
			while (names.has(name)) name = `${bv.name} (${++n})`;
			names.add(name); bv.name = name;
			views.push(bv);
		}
		return views;
	}

	/** Notion metadata kept inside the base itself (Bases preserves unknown top-level keys when it rewrites
	 *  a .base file, unlike comments): database id, icon, and select/status option colors. */
	private notionMeta(ds: PlannedDs, schema: Schema, dbId?: string): Record<string, unknown> {
		const colors: Record<string, Record<string, string>> = {};
		for (const p of schema.ordered) { if (optionsOf(p).length) colors[propKey(p.name)] = Object.fromEntries(optionsOf(p).map(o => [o.name, o.color || 'default'])); }
		const out: Record<string, unknown> = { database: dbId || (ds.sourceDb ? normId(ds.sourceDb.database.id) : undefined), 'data-source': ds.id };
		const desc = plain(ds.snap.data_source?.description) || plain(ds.sourceDb?.database?.description);
		if (desc) out.description = desc;
		if (ds.icon) out.icon = ds.icon;
		if (Object.keys(colors).length) out.colors = colors;
		const tpl = this.templatesOf.get(ds.id) || [];
		if (tpl.length) out.templates = tpl.map(t => ({ name: t.template!.name, file: t.path, ...(t.template!.isDefault ? { default: true } : {}) }));
		const statuses = schema.ordered.filter(p => p.type === 'status').map(p => propKey(p.name));
		if (statuses.length) out.status = statuses;
		return out;
	}

	private defaultView(schema: Schema) {
		return { type: 'table', name: 'Table', order: schema.ordered.filter(p => p.type !== 'button').map(p => columnKey(p, this.ctx.opts.coloredPills)) };
	}

	private baseFile(ds: PlannedDs): string {
		const schema = this.schemaFor(ds);
		const views = this.viewsFor(ds.sourceDb, ds, schema);
		const doc = { notion: this.notionMeta(ds, schema), ...this.baseHeader(ds, schema), views: views.length ? views : [this.defaultView(schema)] };
		return `# Imported from Notion: ${ds.name}\n` + (ds.icon ? `# notion-icon: ${ds.icon}\n` : '') + toYaml(doc);
	}

	private prepareDbRenderers(): void {
		for (const d of Object.values(this.snap.databases)) {
			if (!d.database || d.database.__error) continue;
			const dbId = normId(d.database.id);
			this.ctx.dbRender.set(dbId, () => {
				const lines: string[] = [];
				const title = dbTitle(d.database);
				for (const dsRef of d.data_sources || []) {
					const ds = this.dss.get(normId(dsRef.data_source?.id));
					if (!ds) continue;
					const schema = this.schemaFor(ds);
					const isOwner = ds.sourceDb && normId(ds.sourceDb.database.id) === dbId;
					const showTitle = d.database.show_data_source_title !== false && !(d.database.is_inline && title === 'Untitled');
					if (isOwner) {
						if (showTitle || !d.database.is_inline) lines.push(`<span class="n-db-title">${ds.icon && !/^(\[\[|https?:)/.test(ds.icon) ? ds.icon + ' ' : ''}${title && title !== 'Untitled' ? title : ds.name}</span>`, '');
						lines.push(`![[${ds.basePath}]]`);
						lines.push(...this.templateList(ds));
					} else {
						// linked view: inline base code block scoped to the source folder, with this block's own views
						// (only the views selected for this linked view, in Notion's order; chart/calendar included)
						const views = this.viewsFor(d, ds, schema);
						if (showTitle && title && title !== 'Untitled') lines.push(`<span class="n-db-title">${title}</span>`, '');
						if (views.length) {
							const doc = { notion: this.notionMeta(ds, schema, dbId), ...this.baseHeader(ds, schema), views };
							lines.push('```base', toYaml(doc).trimEnd(), '```');
						}
					}
				}
				while (lines[0] === '') lines.shift();
				if (!lines.length && (d.data_sources || []).some(r => this.skippedIds.has(normId(r.data_source?.id))))
					return [`> [!notion-callout|gray-bg] 🚫`, `> 数据库「${(title || 'Untitled').replace(/[[\]]/g, ' ')}」已设置为「以后不再同步」（原始数据仍在 _raw 里；在设置里可以恢复同步）→ [在 Notion 中打开](${notionUrl(dbId)})`];
				return lines;
			});
		}
	}

	/** Notion keeps templates behind the database's "New ▾" menu; here: a folded list under the database. */
	private templateList(ds: PlannedDs): string[] {
		const tpl = this.templatesOf.get(ds.id) || [];
		if (!tpl.length) return [];
		return ['', `> [!notion-templates]- 📄 模板 (${tpl.length})`,
			...tpl.map(t => `> - [[${t.path.replace(/\.md$/, '')}|${t.template!.name.replace(/[|\]]/g, ' ')}]]${t.template!.isDefault ? ' · 默认' : ''}`)];
	}

	private renderedComments = new Set<string>();

	/** Notion comments (page-level + on any block of the page) as a folded callout at the end of the page. */
	private renderComments(p: PlannedPage): string[] {
		const all = this.snap.comments || {};
		const lookup = (id: string) => all[id] || all[normId(id)] || Object.entries(all).find(([k]) => normId(k) === normId(id))?.[1] || [];
		const groups: { anchor?: string; list: any[] }[] = [];
		const pageC = lookup(p.id);
		if (pageC.length) groups.push({ list: pageC });
		walkBlocks(p.blocks, b => {
			const c = lookup(b.id);
			if (c.length) groups.push({ anchor: plain(b[b.type]?.rich_text) || b.type, list: c });
		});
		if (!groups.length) return [];
		const ctx = this.ctx;
		const n = groups.reduce((a, g) => a + g.list.length, 0);
		const out: string[] = ['', `> [!notion-comments]- 💬 评论 (${n})`];
		for (const g of groups) {
			if (g.anchor) out.push('>', `> > ${g.anchor.replace(/\n/g, ' ').slice(0, 120)}`, '>');
			let disc = '';
			for (const c of g.list) {
				this.renderedComments.add(c.id);
				const who = c.display_name?.resolved_name || ctx.userName(c.created_by) || '?';
				const when = c.created_time ? isoToLocal(c.created_time, ctx.tz).replace('T', ' ') : '';
				if (disc && c.discussion_id !== disc) out.push('>');
				disc = c.discussion_id;
				out.push(`> **${who}** <span class="n-comment-time">${when}</span>`);
				const txt = richText(c.rich_text, ctx);
				for (const l of (txt || ' ').split('\n')) out.push('> ' + l);
				for (const a of c.attachments || []) {
					const url = a?.file?.url;
					if (url) out.push(`> ![[${ctx.asset(url)}]]`);
				}
			}
		}
		return out;
	}

	private renderPage(p: PlannedPage): string {
		const ctx = this.ctx;
		const fm: Record<string, unknown> = { 'notion-id': p.id };
		const pg = p.page || {};
		fm['notion-url'] = pg.url || notionUrl(p.id);
		if (pg.created_time) fm['notion-created'] = isoToLocal(pg.created_time, ctx.tz);
		if (pg.last_edited_time) fm['notion-edited'] = isoToLocal(pg.last_edited_time, ctx.tz);
		const rawTitle = pageTitle(pg);
		if (rawTitle && sanitizeFileName(rawTitle) !== rawTitle) fm['notion-title'] = rawTitle;   // file name had to change
		const icon = iconValue(p.page, ctx);
		if (icon) fm['notion-icon'] = icon;
		const cov = ctx.file(p.page.cover);
		if (cov) fm.cover = cov.local ? `[[${cov.target}]]` : cov.target;
		fm.cssclasses = ['notion'];
		if (p.template) {
			const ds = this.dss.get(p.template.dsId);
			fm['notion-template'] = p.template.name;
			if (ds) fm['notion-template-of'] = `[[${ds.basePath}]]`;
			if (p.template.isDefault) fm['notion-template-default'] = true;
			ctx.audit.templatesWritten++;
		}
		if (p.row) Object.assign(fm, rowFrontmatter(p.page, ctx, new Set(this.liveOf(p.row.dsId).keys())));
		else if (/^(data_source_id|database_id)$/.test(pg.parent?.type || '')) Object.assign(fm, rowFrontmatter(p.page, ctx)); // row of a database the import could not open
		ctx.audit.pagesWritten++;
		if (p.row) ctx.audit.rowsWritten[p.row.dsId] = (ctx.audit.rowsWritten[p.row.dsId] || 0) + 1;
		const body = renderBlocks(p.blocks, ctx);
		body.push(...this.renderComments(p));
		const head: string[] = [];
		if (ctx.opts.staticHeader) {
			if (cov) head.push(cov.local ? `![[${cov.target}|banner]]` : `![banner](${cov.target})`);
			if (icon && !icon.startsWith('[[') && !/^https?:/.test(icon)) head.push(`<span class="n-static-icon">${icon}</span>`);
			if (head.length) head.push('');
		}
		return frontmatter(fm) + (head.length ? head.join('\n') + '\n' : '') + body.join('\n') + '\n';
	}
}

/** the generated page that holds databases only reachable through linked views */
export const UNSORTED_DB_FOLDER = '未归类的数据库';
export const HOLDER_ID = 'holder:unclassified';

function holderNote(dss: PlannedDs[]): string {
	return frontmatter({ 'notion-holder': 'unclassified', 'notion-icon': '🗂️', cssclasses: ['notion'] }) + [
		'> [!notion-callout|gray-bg] 💡',
		'> 这些数据库只出现在其他页面的「链接视图」里：它们在 Notion 中所在的原始页面**没有共享给 integration**，所以导入时不知道该放在哪个页面下面，就先放在这里。',
		'>',
		'> - 想让它们回到原来的位置：在 Notion 里把它们的上级页面也共享（··· → Connections）给 integration，然后再同步一次，会自动移过去。',
		'> - 不需要它们：在左侧页面树里删除（移到回收站），或在 ··· 菜单里选「以后不再同步」。',
		'> - 也可以把它们拖到别的页面里；以后同步会更新到你放的位置。',
		'',
		...dss.map(d => `- ${d.icon && !/^(\[\[|https?:)/.test(d.icon) ? '' : '🗃️ '}[[${d.basePath}|${d.name.replace(/[[\]|]/g, ' ')}]]`),
	].join('\n') + '\n';
}

export function convertSnapshot(snap: Snapshot, opts: Partial<ConvertOptions> = {}): ConvertResult {
	return new Converter(snap, opts).run();
}
