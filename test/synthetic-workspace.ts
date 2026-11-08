/* eslint-disable @typescript-eslint/no-explicit-any */
// A fictional Notion workspace, built in code, in the shape the plugin's crawler stores (pages + blocks, databases +
// views + data sources + rows). Everything here is made up: names, books, people, ids. It exercises what the tests
// and the offline sample vault need: full-page and inline databases, linked views (table / board / gallery / list /
// calendar / chart / form), relations, rollups, formulas, covers, emoji icons, duplicate titles, nested blocks,
// databases inside columns, and databases that are only reachable through search ("unsorted").
import type { Snapshot } from '../src/core/types.ts';

const T0 = '2026-01-05T09:00:00.000Z';
const T1 = '2026-01-20T12:30:00.000Z';
const USER = { object: 'user', id: '00000000-0000-4000-a000-000000000001' };

let seq = 0;
/** deterministic fake UUID; prefix keeps the kinds apart when reading raw output */
const id = (kind: number) => { seq++; return `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`; };
const ann = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
const rt = (s: string, a: any = {}) => (s ? [{ type: 'text', text: { content: s, link: null }, annotations: { ...ann, ...a }, plain_text: s, href: null }] : []);
const url = (x: string) => `https://www.notion.so/${x.replace(/-/g, '')}`;
const emoji = (e: string) => ({ type: 'emoji', emoji: e });

// ------------------------------------------------------------------ blocks
const blk = (type: string, data: any = {}, children?: any[]) => ({
	object: 'block', id: id(0xb), type, [type]: data, created_time: T0, last_edited_time: T1, created_by: USER, last_edited_by: USER,
	has_children: !!children?.length, in_trash: false, ...(children?.length ? { children } : {}),
});
const p = (s: string, a: any = {}) => blk('paragraph', { rich_text: rt(s, a), color: 'default' });
const h = (n: 1 | 2 | 3, s: string, toggle = false, kids?: any[]) => blk(`heading_${n}`, { rich_text: rt(s), is_toggleable: toggle, color: 'default' }, kids);
const li = (s: string, kids?: any[]) => blk('bulleted_list_item', { rich_text: rt(s), color: 'default' }, kids);
const ol = (s: string) => blk('numbered_list_item', { rich_text: rt(s), color: 'default' });
const todo = (s: string, checked = false) => blk('to_do', { rich_text: rt(s), checked, color: 'default' });
const callout = (s: string, icon: string, color = 'gray_background', kids?: any[]) => blk('callout', { rich_text: rt(s), icon: emoji(icon), color }, kids);
const toggle = (s: string, kids: any[]) => blk('toggle', { rich_text: rt(s), color: 'default' }, kids);
const quote = (s: string) => blk('quote', { rich_text: rt(s), color: 'default' });
const code = (s: string, language = 'javascript') => blk('code', { rich_text: rt(s), language, caption: [] });
const divider = () => blk('divider');
const columns = (...cols: any[][]) => blk('column_list', {}, cols.map(c => blk('column', { width_ratio: 1 / cols.length }, c)));
const table = (rows: string[][]) => blk('table', { table_width: rows[0].length, has_column_header: true, has_row_header: false },
	rows.map(r => blk('table_row', { cells: r.map(c => rt(c)) })));

// ------------------------------------------------------------------ databases
type Prop = { name: string; id: string; type: string; [k: string]: any };
interface DsDef { db: any; ds: any; rows: any[]; props: Record<string, Prop> }
const snapPages: Snapshot['pages'] = {};
const snapDbs: Snapshot['databases'] = {};

function page(title: string, parent: any, extra: any = {}, blocks: any[] = []): any {
	const pid = id(0xa);
	const pg = { object: 'page', id: pid, created_time: T0, last_edited_time: T1, created_by: USER, last_edited_by: USER, cover: null, icon: null,
		parent, in_trash: false, archived: false, is_locked: false, url: url(pid), public_url: null,
		properties: { title: { id: 'title', type: 'title', title: rt(title) } }, ...extra };
	snapPages[pid] = { page: pg, blocks } as any;
	return pg;
}
const childPage = (pg: any) => withId(blk('child_page', { title: pg.properties.title?.title?.[0]?.plain_text ?? '' }), pg.id);
function withId<T extends { id: string }>(b: any, newId: string): T { b.id = newId; return b; }

function database(title: string, parent: any, icon: string | null, props: Prop[], inline = false): DsDef {
	const dbId = id(0xd), dsId = id(0xe);
	const properties: Record<string, any> = {};
	const byName: Record<string, Prop> = {};
	for (const pr of props) { const { name, id: pid, type, ...rest } = pr; properties[name] = { id: pid, name, description: null, type, [type]: rest[type] ?? {} }; byName[name] = pr; }
	const ds = { object: 'data_source', id: dsId, created_time: T0, last_edited_time: T1, created_by: USER, last_edited_by: USER, cover: null,
		icon: icon ? emoji(icon) : null, title: rt(title), description: [], is_inline: inline, parent: { type: 'database_id', database_id: dbId }, properties };
	const db = { object: 'database', id: dbId, title: rt(title), description: [], parent, is_inline: inline, in_trash: false, is_locked: false,
		show_data_source_title: true, created_time: T0, last_edited_time: T1, data_sources: [{ id: dsId, name: title }], icon: icon ? emoji(icon) : null, cover: null, url: url(dbId) };
	const def: DsDef = { db, ds, rows: [], props: byName };
	snapDbs[dbId] = { database: db, views: [], data_sources: [{ data_source: ds, rows: def.rows, templates: [] }] } as any;
	return def;
}
function view(owner: DsDef, dbId: string, name: string, type: string, configuration: any = {}, filter: any = null, sorts: any = null): any {
	const vid = id(0xf);
	return { object: 'view', id: vid, parent: { type: 'database_id', database_id: dbId }, data_source_id: owner.ds.id, name, type, created_time: T0, last_edited_time: T1,
		url: `${url(dbId)}?v=${vid.replace(/-/g, '')}`, filter, sorts, quick_filters: null, configuration: { type, ...configuration } };
}
function addViews(def: DsDef, ...vs: any[][]): void { snapDbs[def.db.id].views!.push(...vs.map(v => view(def, def.db.id, v[0], v[1], v[2], v[3], v[4]))); }
/** a linked (inline) view of `src` placed as a block; returns the child_database block */
function linked(src: DsDef, parent: any, ...vs: any[][]): any {
	const dbId = id(0xd);
	const db = { ...src.db, id: dbId, title: rt('Untitled'), parent, is_inline: true, data_sources: [{ id: src.ds.id, name: src.ds.title[0].plain_text }], url: url(dbId) };
	snapDbs[dbId] = { database: db, views: vs.map(v => view(src, dbId, v[0], v[1], v[2], v[3], v[4])), data_sources: [{ data_source: src.ds, rows: [], templates: [] }] } as any;
	return withId(blk('child_database', { title: 'Untitled' }), dbId);
}
const ownerBlock = (def: DsDef) => withId(blk('child_database', { title: def.db.title[0].plain_text }), def.db.id);

function row(def: DsDef, title: string, values: Record<string, any>, extra: any = {}, body: any[] = []): any {
	const r = page(title, { type: 'data_source_id', data_source_id: def.ds.id, database_id: def.db.id }, extra, body);
	const properties: Record<string, any> = { };
	for (const [name, pr] of Object.entries(def.props)) {
		const v = pr.type === 'title' ? rt(title) : values[name];
		properties[name] = { id: pr.id, type: pr.type, [pr.type]: v ?? emptyValue(pr.type) };
		if (pr.type === 'relation') properties[name].has_more = false;
	}
	r.properties = properties;
	def.rows.push(r);
	return r;
}
function emptyValue(type: string): any {
	switch (type) {
		case 'rich_text': case 'multi_select': case 'relation': case 'people': case 'files': return [];
		case 'checkbox': return false;
		default: return null;
	}
}
const sel = (name: string, color: string) => ({ name, color });
const date = (start: string, end: string | null = null) => ({ start, end, time_zone: null });
const rel = (...rs: any[]) => rs.map(r => ({ id: r.id }));
const fNum = (n: number) => ({ type: 'number', number: n });
const fStr = (s: string) => ({ type: 'string', string: s });
const fBool = (b: boolean) => ({ type: 'boolean', boolean: b });
const roll = (type: string, v: any, fn: string) => ({ type, [type]: v, function: fn });
const opts = (...o: [string, string][]) => ({ options: o.map(([name, color], i) => ({ id: `opt-${name}-${i}`, name, color, description: null })) });

// ================================================================== the workspace
// Home Hub (a personal dashboard) → Databases (Projects, Tasks, Areas, Resources) + linked views on the home page;
// Reading List → Books + Authors, galleries (one inside a column), charts; Journal → many blocks; Block showcase;
// three databases reachable only through search ("unsorted").
export function syntheticSnapshot(): Snapshot {
	seq = 0;
	for (const k of Object.keys(snapPages)) delete snapPages[k];
	for (const k of Object.keys(snapDbs)) delete snapDbs[k];

	const home = page('Home Hub', { type: 'workspace', workspace: true }, { icon: emoji('🏠'), cover: { type: 'external', external: { url: 'https://www.notion.so/images/page-cover/solid_blue.png' } } });
	const dbPage = page('Databases', { type: 'page_id', page_id: home.id }, { icon: emoji('🗄️') });
	const inDb = { type: 'page_id', page_id: dbPage.id };

	const areas = database('Areas', inDb, '🧭', [{ name: 'Name', id: 'title', type: 'title' }, { name: 'Owner', id: 'aown', type: 'rich_text' }]);
	const tasks = database('Tasks', inDb, '✅', [
		{ name: 'Name', id: 'title', type: 'title' }, { name: 'Done', id: 'tdon', type: 'checkbox' }, { name: 'Date', id: 'tdat', type: 'date' },
		{ name: 'Priority', id: 'tpri', type: 'select', select: opts(['High', 'red'], ['Medium', 'yellow'], ['Low', 'gray']) },
		{ name: 'Project', id: 'tprj', type: 'relation', relation: { data_source_id: 'PROJECTS', type: 'dual_property', dual_property: {} } },
	]);
	const resources = database('Resources', inDb, '📎', [
		{ name: 'Name', id: 'title', type: 'title' }, { name: 'Status', id: 'rsta', type: 'status', status: opts(['Not started', 'default'], ['In progress', 'blue'], ['Done', 'green']) },
		{ name: 'Link', id: 'rurl', type: 'url' }, { name: 'Project', id: 'rprj', type: 'relation', relation: { data_source_id: 'PROJECTS', type: 'dual_property', dual_property: {} } },
	]);
	const projects = database('Projects', inDb, '📁', [
		{ name: 'Name', id: 'title', type: 'title' },
		{ name: 'Area', id: 'parea', type: 'relation', relation: { data_source_id: areas.ds.id, database_id: areas.db.id, type: 'single_property', single_property: {} } },
		{ name: 'Order', id: 'pord', type: 'number', number: { format: 'number' } },
		{ name: 'Status', id: 'psta', type: 'select', select: opts(['Not started', 'gray'], ['In progress', 'blue'], ['Done', 'green'], ['Archived', 'brown']) },
		{ name: 'Timeline', id: 'ptim', type: 'date' },
		{ name: 'Tasks', id: 'ptsk', type: 'relation', relation: { data_source_id: tasks.ds.id, database_id: tasks.db.id, type: 'dual_property', dual_property: { synced_property_name: 'Project', synced_property_id: 'tprj' } } },
		{ name: 'Resources', id: 'pres', type: 'relation', relation: { data_source_id: resources.ds.id, database_id: resources.db.id, type: 'dual_property', dual_property: { synced_property_name: 'Project', synced_property_id: 'rprj' } } },
		{ name: 'Completion', id: 'pcmp', type: 'rollup', rollup: { relation_property_name: 'Tasks', relation_property_id: 'ptsk', rollup_property_name: 'Done', rollup_property_id: 'tdon', function: 'percent_checked' } },
		{ name: 'Resource States', id: 'prst', type: 'rollup', rollup: { relation_property_name: 'Resources', relation_property_id: 'pres', rollup_property_name: 'Status', rollup_property_id: 'rsta', function: 'show_original' } },
		{ name: 'Auto Status', id: 'paut', type: 'formula', formula: { expression: 'ifs(prop("Status") == "Archived", "Archived", prop("Tasks").length() > 0 and prop("Completion") == 1, "Done", prop("Completion") > 0 or prop("Resource States").format().contains("In progress"), "In progress", "Not started")' } },
		{ name: 'Progress', id: 'pprg', type: 'formula', formula: { expression: 'if(prop("Tasks").length() == 0, 0, round(prop("Completion") * 100))' } },
		{ name: 'Memo', id: 'pmem', type: 'rich_text' },
	]);
	for (const d of [tasks, resources]) d.ds.properties.Project.relation = { data_source_id: projects.ds.id, database_id: projects.db.id, type: 'dual_property', dual_property: { synced_property_name: d === tasks ? 'Tasks' : 'Resources', synced_property_id: d === tasks ? 'ptsk' : 'pres' } };

	const aW = row(areas, 'Work', { Owner: rt('Alex') }, { icon: emoji('💼') });
	const aH = row(areas, 'Health', {}, { icon: emoji('🍎') });
	const aL = row(areas, 'Learning', {}, { icon: emoji('📚') });
	const prjNames: [string, string, any, string][] = [['Garden shed', '🛖', aH, 'In progress'], ['Learn Rust', '🦀', aL, 'In progress'], ['Quarterly report', '📊', aW, 'Done'],
		['Marathon plan', '🏃', aH, 'Not started'], ['Old website', '🕸️', aW, 'Archived'], ['Photo album', '📷', aL, 'Not started']];
	const prjs: any[] = [];
	prjNames.forEach(([n, ic, area, st], i) => {
		const pr = row(projects, n, { Area: rel(area), Order: i + 1, Status: sel(st, 'gray'), Timeline: date(`2026-0${(i % 6) + 1}-01`, `2026-0${(i % 6) + 2}-15`), Memo: rt(`Notes for ${n.toLowerCase()}.`) },
			{ icon: emoji(ic) }, [p(`What "${n}" is about.`), todo('First step', true), todo('Second step')]);
		prjs.push(pr);
	});
	const taskList: any[] = [];
	for (let i = 0; i < 14; i++) {
		const pr = prjs[i % prjs.length];
		const t = row(tasks, `Task ${i + 1}`, { Done: i % 3 === 0, Date: i % 4 === 3 ? null : date(`2026-01-${String(5 + i).padStart(2, '0')}${i % 5 === 0 ? 'T09:30:00.000+08:00' : ''}`), Priority: sel(['High', 'Medium', 'Low'][i % 3], ['red', 'yellow', 'gray'][i % 3]), Project: rel(pr) });
		taskList.push(t);
	}
	const resList: any[] = [];
	for (let i = 0; i < 8; i++) resList.push(row(resources, `Resource ${String.fromCharCode(65 + i)}`, { Status: sel(['Not started', 'In progress', 'Done'][i % 3], ['default', 'blue', 'green'][i % 3]), Link: `https://example.com/r/${i}`, Project: rel(prjs[i % prjs.length]) },
		{ cover: { type: 'external', external: { url: `https://example.com/covers/r${i}.png` } } }));
	prjs.forEach(pr => {
		const ts = taskList.filter(t => t.properties.Project.relation[0].id === pr.id);
		const rs = resList.filter(r => r.properties.Project.relation[0].id === pr.id);
		const done = ts.filter(t => t.properties.Done.checkbox).length;
		pr.properties.Tasks.relation = rel(...ts);
		pr.properties.Resources.relation = rel(...rs);
		pr.properties.Completion.rollup = roll('number', ts.length ? done / ts.length : 0, 'percent_checked');
		pr.properties['Resource States'].rollup = roll('array', rs.map(r => ({ type: 'status', status: r.properties.Status.status })), 'show_original');
		const st = pr.properties.Status.select.name;
		pr.properties['Auto Status'].formula = fStr(st === 'Archived' ? 'Archived' : ts.length && done === ts.length ? 'Done' : done ? 'In progress' : 'Not started');
		pr.properties.Progress.formula = fNum(Math.round((ts.length ? done / ts.length : 0) * 100));
	});
	for (const t of taskList) t.properties.Project.relation = rel(prjs.find(x => x.id === t.properties.Project.relation[0].id));
	snapDbs[projects.db.id].data_sources[0].templates = [];

	const P = projects.props;
	addViews(projects,
		['All', 'table', { properties: ['Name', 'Area', 'Order', 'Auto Status', 'Status', 'Progress', 'Completion', 'Timeline', 'Tasks', 'Resources'].map(n => ({ property_id: P[n].id, property_name: n, visible: true })) }, null, [{ property: 'pord', direction: 'ascending' }]],
		['By Status', 'board', { group_by: { type: 'formula', property_id: 'paut', group_by: { type: 'text', group_by: 'exact', sort: { type: 'manual' } }, property_name: 'Auto Status', hide_empty_groups: false } }, null, [{ property: 'pord', direction: 'ascending' }]],
		['By Area', 'table', { group_by: { type: 'relation', property_id: 'parea', sort: { type: 'manual' }, property_name: 'Area', hide_empty_groups: true } }, null, [{ property: 'pord', direction: 'ascending' }]]);
	addViews(tasks, ['All', 'table'], ['➕ New task', 'form'], ['Unscheduled', 'table', {}, { property: 'tdat', date: { is_empty: true } }]);
	addViews(resources, ['All', 'table'], ['Gallery', 'gallery', { cover: { type: 'page_cover' }, cover_size: 'medium', card_layout: 'compact' }]);
	addViews(areas, ['Default view', 'table']);

	const reviews = page('Reviews', { type: 'page_id', page_id: home.id }, { icon: emoji('🔁') }, [h(2, 'Weekly review'), todo('Inbox zero'), todo('Plan next week'), p('Look back, then ahead.')]);
	const mobile = page('Mobile', { type: 'page_id', page_id: home.id }, { icon: emoji('📱') }, [p('A small dashboard for the phone.')]);
	snapPages[dbPage.id].blocks = [ownerBlock(projects), ownerBlock(tasks), ownerBlock(areas), ownerBlock(resources)];
	snapPages[home.id].blocks = [
		callout('Welcome to the Home Hub. Everything below is fictional sample data.', '👋', 'blue_background'),
		columns(
			[h(3, 'Today'), linked(tasks, { type: 'block_id', block_id: 'col' }, ['Today', 'list', {}, { property: 'tdat', date: { this_week: {} } }]),
				linked(tasks, { type: 'block_id', block_id: 'col' }, ['Coming up', 'list', {}, { property: 'tdat', date: { next_week: {} } }])],
			[h(3, 'Projects'), linked(projects, { type: 'block_id', block_id: 'col' }, ['Active', 'list', {}, { property: 'psta', select: { equals: 'In progress' } }])]),
		h(2, 'All projects'),
		linked(projects, { type: 'page_id', page_id: home.id },
			['Overview', 'table', {}, null, [{ property: 'pord', direction: 'ascending' }]],
			['By Status', 'board', { group_by: { type: 'formula', property_id: 'paut', group_by: { type: 'text', group_by: 'exact', sort: { type: 'manual' } }, property_name: 'Auto Status', hide_empty_groups: false } }],
			['By Area', 'table', { group_by: { type: 'relation', property_id: 'parea', sort: { type: 'manual' }, property_name: 'Area', hide_empty_groups: true } }]),
		h(2, 'Calendar'),
		linked(tasks, { type: 'page_id', page_id: home.id },
			['This Week', 'calendar', { date_property_id: 'tdat', date_property_name: 'Date', view_range: 'week', show_weekends: true }],
			['This Month', 'calendar', { date_property_id: 'tdat', date_property_name: 'Date', view_range: 'month', show_weekends: true }]),
		h(2, 'Resources'),
		linked(resources, { type: 'page_id', page_id: home.id }, ['Resources', 'gallery', { cover: { type: 'page_cover' }, card_layout: 'compact' }]),
		h(2, 'Lists'),
		linked(tasks, { type: 'page_id', page_id: home.id }, ['Open tasks', 'list', {}, { property: 'tdon', checkbox: { equals: false } }]),
		linked(projects, { type: 'page_id', page_id: home.id }, ['Projects', 'table']),
		linked(resources, { type: 'page_id', page_id: home.id }, ['Open resources', 'table', {}, { property: 'rsta', status: { does_not_equal: 'Done' } }]),
		childPage(reviews), childPage(mobile), childPage(dbPage),
	];

	// ---------------- Reading List
	const reading = page('Reading List', { type: 'workspace', workspace: true }, { icon: emoji('📖') });
	const inReading = { type: 'page_id', page_id: reading.id };
	const authors = database('Authors', inReading, '✍️', [{ name: 'Name', id: 'title', type: 'title' }, { name: 'Books', id: 'abks', type: 'relation', relation: { data_source_id: 'BOOKS' } },
		{ name: 'Book count', id: 'acnt', type: 'formula', formula: { expression: 'prop("Books").length()' } }]);
	const books = database('Books', inReading, '📚', [
		{ name: 'Name', id: 'title', type: 'title' },
		{ name: 'Category', id: 'bcat', type: 'select', select: opts(['Fiction', 'purple'], ['Science', 'blue'], ['History', 'brown'], ['Poetry', 'pink']) },
		{ name: 'State', id: 'bsta', type: 'select', select: opts(['Finished', 'green'], ['To read', 'gray'], ['Paused', 'orange'], ['Reading', 'blue']) },
		{ name: 'Finished on', id: 'bfin', type: 'date' },
		{ name: 'Progress', id: 'bprg', type: 'number', number: { format: 'percent' } },
		{ name: 'Progress bar', id: 'bbar', type: 'formula', formula: { expression: 'style(repeat("■", round(prop("Progress") * 10)), "b", "green")' } },
		{ name: 'Recent', id: 'brec', type: 'formula', formula: { expression: 'dateBetween(now(), prop("Finished on"), "days") <= 183' } },
		{ name: 'Author', id: 'baut', type: 'relation', relation: { data_source_id: authors.ds.id, database_id: authors.db.id, type: 'dual_property', dual_property: { synced_property_name: 'Books', synced_property_id: 'abks' } } },
		{ name: 'Rating', id: 'brat', type: 'number' },
	]);
	authors.ds.properties.Books.relation = { data_source_id: books.ds.id, database_id: books.db.id, type: 'dual_property', dual_property: { synced_property_name: 'Author', synced_property_id: 'baut' } };
	const authorNames = ['Mara Quill', 'Tobias Fenn', 'Ines Calloway', 'Jun Arkwright', 'Selma Ostrander'];
	const auth = authorNames.map((n, i) => row(authors, n, {}, { icon: emoji(['🦉', '🌲', '🌙', '🪁', '🐚'][i]) }));
	const titles = ['Notes on Rivers', 'The Glass Orchard', 'A Map of Small Things', 'Notes on Rivers', 'Lanterns at Noon', 'The Quiet Engine', 'Salt and Static', 'Paper Comets',
		'The Long Tide', 'Clockwork Bees', 'Winter Grammar', 'Echoes of Brass', 'The Ninth Hill', 'Moss Theory', 'Harbor Lights', 'Field Guide to Rain', 'Copper Moon', 'The Empty Atlas',
		'Seven Kettles', 'Velvet Arithmetic', 'Driftwood Letters', 'The Cartographer\'s Cat', 'Small Hours', 'Ink and Orbit'];
	const icons = ['🌊', '🍏', '🗺️', '🏞️', '🏮', '⚙️', '🧂', '☄️', '🌅', '🐝', '❄️', '🎺', '⛰️', '🌿', '⚓', '🌧️', '🌕', '🧭', '🫖', '🧮', '🪵', '🐈', '🕰️', '🪐'];
	const states: [string, string][] = [['Finished', 'green'], ['To read', 'gray'], ['Paused', 'orange'], ['Reading', 'blue']];
	const cats: [string, string][] = [['Fiction', 'purple'], ['Science', 'blue'], ['History', 'brown'], ['Poetry', 'pink']];
	const bookRows = titles.map((t, i) => {
		const st = states[i % 4], fin = st[0] === 'Finished' ? date(`2026-0${(i % 9) + 1}-1${i % 9}`) : null;
		const prog = st[0] === 'Finished' ? 1 : (i % 10) / 10;
		const b = row(books, t, { Category: sel(...cats[i % 4]), State: sel(...st), 'Finished on': fin, Progress: prog, Author: rel(auth[i % auth.length]), Rating: (i % 5) + 1 },
			{ icon: emoji(icons[i]), cover: { type: 'external', external: { url: `https://example.com/covers/book-${i}.jpg` } } });
		b.properties['Progress bar'].formula = fStr('■'.repeat(Math.round(prog * 10)));
		b.properties.Recent.formula = fBool(!!fin);
		return b;
	});
	auth.forEach((a, i) => { const bs = bookRows.filter((_, j) => j % auth.length === i); a.properties.Books.relation = rel(...bs); a.properties['Book count'].formula = fNum(bs.length); });
	addViews(books, ['Default view', 'table'], ['Covers', 'gallery', { cover: { type: 'page_cover' }, cover_size: 'large' }]);
	addViews(authors, ['Default view', 'table']);
	const B = books.props;
	const colBlock = 'col-reading';
	snapPages[reading.id].blocks = [
		quote('A fictional reading log used by the tests and the sample vault.'),
		linked(books, inReading,
			['All', 'gallery', { cover: { type: 'page_cover' }, cover_size: 'medium' }],
			['By category', 'board', { group_by: { type: 'select', property_id: 'bcat', sort: { type: 'manual' }, property_name: 'Category', hide_empty_groups: true } }],
			['Finished', 'gallery', { cover: { type: 'page_cover' } }, { property: 'bsta', select: { equals: 'Finished' } }],
			['To read', 'gallery', { cover: { type: 'page_cover' } }, { property: 'bsta', select: { equals: 'To read' } }],
			['Paused', 'gallery', { cover: { type: 'page_cover' } }, { property: 'bsta', select: { equals: 'Paused' } }],
			['Table', 'table']),
		columns(
			[h(3, 'Recently finished'), linked(books, { type: 'block_id', block_id: colBlock },
				['🕰️ Finished recently', 'gallery', { properties: [{ property_id: 'title', visible: true }, { property_id: 'bcat', visible: true }, ...['bsta', 'bfin', 'bprg', 'bbar', 'brec', 'baut', 'brat'].map(x => ({ property_id: x, visible: false }))],
					cover: { type: 'page_cover' }, cover_size: 'small', cover_aspect: 'contain', card_layout: 'list' },
				{ and: [{ property: 'bsta', select: { equals: 'Finished' } }, { property: 'brec', formula: { checkbox: { equals: true } } }] }, [{ property: 'bfin', direction: 'descending' }]])],
			[h(3, 'Reading now'), linked(books, { type: 'block_id', block_id: colBlock }, ['📖 Reading', 'gallery', { cover: { type: 'page_cover' }, card_layout: 'compact' }, { property: 'bsta', select: { equals: 'Reading' } }])]),
		h(2, 'Statistics'),
		linked(books, inReading,
			['Category chart', 'chart', { chart_type: 'donut', x_axis: { type: 'select', property_id: 'bcat', sort: { type: 'manual' }, property_name: 'Category', hide_empty_groups: true }, y_axis: { aggregator: 'count' }, donut_labels: 'name_and_value' }],
			['State chart', 'chart', { chart_type: 'donut', x_axis: { type: 'select', property_id: 'bsta', sort: { type: 'manual' }, property_name: 'State', hide_empty_groups: true }, y_axis: { aggregator: 'count' } }]),
		linked(books, inReading, ['Themes', 'board', { group_by: { type: 'select', property_id: 'bcat', sort: { type: 'manual' }, property_name: 'Category', hide_empty_groups: true } }]),
		linked(authors, inReading, ['Authors', 'gallery', { card_layout: 'compact' }]),
		ownerBlock(books), ownerBlock(authors),
	];
	void B;

	// ---------------- Journal: many blocks of every common type
	const journal = page('Journal', { type: 'workspace', workspace: true }, { icon: emoji('📓') });
	const jb: any[] = [h(1, 'Journal')];
	for (let d = 1; d <= 40; d++) jb.push(h(2, `Day ${d}`), p(`Morning pages for day ${d}: weather was ${['sunny', 'cloudy', 'rainy', 'windy'][d % 4]}.`, d % 7 === 0 ? { bold: true } : {}),
		li('Walked to the park', [li('saw ducks')]), ol('Read a chapter'), todo('Water the plants', d % 2 === 0), toggle('Details', [p('Hidden thoughts.')]), divider());
	snapPages[journal.id].blocks = jb;

	// ---------------- Block showcase
	const show = page('Block showcase', { type: 'workspace', workspace: true }, { icon: emoji('🧪') });
	snapPages[show.id].blocks = [
		h(1, 'Heading 1'), h(2, 'Toggle heading', true, [p('inside a toggle heading')]), h(3, 'Heading 3'),
		p('Bold', { bold: true }), p('Italic and red', { italic: true, color: 'red' }), p('Code span', { code: true }),
		callout('A tip with a lightbulb', '💡', 'yellow_background', [li('nested list in a callout')]), callout('Warning', '⚠️', 'red_background'),
		quote('To be, or not to be.'), code('const answer = 42;\nconsole.log(answer);'), code('print("hi")', 'python'),
		table([['Fruit', 'Colour'], ['Apple', 'Red'], ['Banana', 'Yellow']]),
		columns([p('Left column')], [p('Middle column')], [p('Right column')]),
		blk('equation', { expression: 'e^{i\\pi} + 1 = 0' }), blk('bookmark', { url: 'https://example.com/', caption: [] }),
		blk('image', { type: 'external', external: { url: 'https://example.com/picture.png' }, caption: rt('An example picture') }),
		blk('table_of_contents', { color: 'default' }), divider(), todo('Done item', true), todo('Open item'),
	];

	// ---------------- databases only reachable through search (their page is not shared)
	const hidden = { type: 'page_id', page_id: '0000dead-0000-4000-8000-000000000000' };
	const tt = database('Timetable', hidden, null, [{ name: 'Name', id: 'title', type: 'title' }, { name: 'Day', id: 'tday', type: 'select', select: opts(['Mon', 'blue'], ['Tue', 'green']) }]);
	row(tt, 'Monday', { Day: sel('Mon', 'blue') });
	database('Wishlist', hidden, null, [{ name: 'Name', id: 'title', type: 'title' }]);
	database('Weekly Plan', hidden, null, [{ name: 'Name', id: 'title', type: 'title' }]);
	for (const d of Object.values(snapDbs)) if (normParent(d.database.parent) === hidden.page_id) d.views = [];

	return {
		roots: [home.id, reading.id, journal.id, show.id],
		pages: structuredClone(snapPages),
		databases: structuredClone(snapDbs),
		users: { [USER.id]: { object: 'user', id: USER.id, name: 'Alex Doe', type: 'person' } },
		complete: true,
	} as Snapshot;
}
const normParent = (pa: any) => pa?.page_id;
