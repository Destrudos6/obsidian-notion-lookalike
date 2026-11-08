/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { Ctx } from '../src/core/context.ts';
import { renderBlocks } from '../src/core/blocks.ts';
import { richText } from '../src/core/richtext.ts';
import { DEFAULT_OPTIONS } from '../src/core/types.ts';
import { convertFilter, convertView, schemaOf } from '../src/core/views.ts';
import { convertSnapshot } from '../src/core/convert.ts';
import { matches } from '../src/render/filter.ts';
import { renderChart, parseSpec } from '../src/render/views.ts';
import { toHtml } from '../src/render/hnode.ts';
import { loadSnapshot } from '../scripts/load-fixtures.ts';

const ann = (o: any = {}) => ({ bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default', ...o });
const t = (s: string, a: any = {}, href: string | null = null) => ({ type: 'text', text: { content: s, link: href ? { url: href } : null }, annotations: ann(a), plain_text: s, href });
const blk = (type: string, data: any, children?: any[]) => ({ id: Math.random().toString(16).slice(2), type, [type]: data, has_children: !!children, children });
const ctx = () => new Ctx({ ...DEFAULT_OPTIONS });

test('rich text: marks, colors, spaces kept outside marks', () => {
	const md = richText([t('Hello '), t('bold ', { bold: true }), t('red', { color: 'red' }), t(' hi', { color: 'yellow_background', italic: true })], ctx());
	assert.equal(md, 'Hello **bold** <span class="n-c-red">red</span> *<mark class="n-bg-yellow">hi</mark>*');
});

test('rich text: notion page link becomes wikilink when imported', () => {
	const c = ctx();
	c.links.set('0123456789abcdef0123456789abcdef', { path: 'N/Page', title: 'Page', kind: 'page' });
	assert.equal(richText([t('see', {}, 'https://www.notion.so/Page-0123456789abcdef0123456789abcdef')], c), '[[N/Page|see]]');
	assert.equal(richText([t('ext', {}, 'https://example.com')], c), '[ext](https://example.com)');
});

test('callout keeps icon + background color', () => {
	const lines = renderBlocks([blk('callout', { rich_text: [t('Note')], icon: { type: 'emoji', emoji: '💡' }, color: 'gray_background' })], ctx());
	assert.deepEqual(lines, ['> [!notion-callout|gray-bg] 💡', '> Note']);
});

test('toggle → collapsed toggle callout with children; toggle heading', () => {
	const lines = renderBlocks([
		blk('toggle', { rich_text: [t('More')] }, [blk('paragraph', { rich_text: [t('inside')] })]),
		blk('heading_2', { rich_text: [t('H')], is_toggleable: true }, [blk('paragraph', { rich_text: [t('x')] })]),
	], ctx());
	assert.deepEqual(lines, ['> [!toggle]- More', '> inside', '', '> [!toggle-h2]- H', '> x']);
});

test('columns → nested column callouts with width ratio', () => {
	const lines = renderBlocks([blk('column_list', {}, [
		blk('column', { width_ratio: 0.3 }, [blk('paragraph', { rich_text: [t('A')] })]),
		blk('column', { width_ratio: 0.7 }, [blk('paragraph', { rich_text: [t('B')] })]),
	])], ctx());
	assert.deepEqual(lines, ['> [!notion-columns|2]', '> > [!notion-column|w30]', '> > A', '>', '> > [!notion-column|w70]', '> > B']);
});

test('lists: tight, nested, to-do', () => {
	const lines = renderBlocks([
		blk('bulleted_list_item', { rich_text: [t('a')] }, [blk('bulleted_list_item', { rich_text: [t('a1')] })]),
		blk('bulleted_list_item', { rich_text: [t('b')] }),
		blk('to_do', { rich_text: [t('done')], checked: true }),
	], ctx());
	assert.deepEqual(lines, ['- a', '    - a1', '- b', '', '- [x] done']);
});

test('table with header row', () => {
	const row = (...c: string[]) => blk('table_row', { cells: c.map(x => [t(x)]) });
	const lines = renderBlocks([blk('table', { table_width: 2, has_column_header: true }, [row('h1', 'h|2'), row('a', 'b')])], ctx());
	assert.deepEqual(lines, ['| h1 | h\\|2 |', '| --- | --- |', '| a | b |']);
});

const ds = {
	properties: {
		Name: { id: 'title', type: 'title', title: {} },
		Status: { id: 'st', type: 'select', select: { options: [{ name: 'Todo', color: 'red' }, { name: 'Doing', color: 'blue' }, { name: 'Done', color: 'green' }] } },
		Done: { id: 'dn', type: 'checkbox', checkbox: {} },
		Area: { id: 'ar', type: 'relation', relation: {} },
		Date: { id: 'dt', type: 'date', date: {} },
	},
};

test('filters → Bases expressions + simple filters', () => {
	const c = ctx(); c.links.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { path: 'N/Areas/Math', title: 'Math', kind: 'page' });
	const s = schemaOf(ds);
	const f = convertFilter({ and: [
		{ property: 'dn', checkbox: { equals: false } },
		{ property: 'st', select: { does_not_equal: 'Done' } },
		{ property: 'ar', relation: { contains: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } },
		{ property: 'dt', date: { on_or_before: 'today' } },
	] }, s, c);
	assert.equal(f.expr, '(note["Done"] != true && note["Status"] != "Done" && list(note["Area"]).contains(link("N/Areas/Math")) && note["Date"] <= today())');
	const row = { name: 'x', path: 'x.md', props: { Done: false, Status: 'Doing', Area: ['[[N/Areas/Math|Math]]'], Date: '2000-01-01' } };
	assert.equal(matches(f.simple, row), true);
	assert.equal(matches(f.simple, { ...row, props: { ...row.props, Status: 'Done' } }), false);
});

test('board → kanban with option order; gallery → cards with cover; select sort uses option order', () => {
	const s = schemaOf(ds);
	const board = convertView({ name: 'Board', type: 'board', configuration: { type: 'board', group_by: { type: 'select', property_id: 'st', sort: { type: 'manual' }, hide_empty_groups: true } } }, { schema: s, pills: true, hasCovers: false }, ctx()) as any;
	assert.equal(board.type, 'kanban');
	assert.deepEqual(board.groupBy, { property: 'note.Status', direction: 'ASC' });
	assert.deepEqual(board.groupOrder, ['Todo', 'Doing', 'Done']);
	const gal = convertView({ name: 'G', type: 'gallery', sorts: [{ property: 'st', direction: 'ascending' }], configuration: { type: 'gallery', card_layout: 'compact' } }, { schema: s, pills: true, hasCovers: true }, ctx()) as any;
	assert.equal(gal.type, 'cards');
	assert.equal(gal.image, 'note.cover');
	assert.match(gal.sort[0].property, /^formula\.ord_/);
	assert.equal(convertView({ name: 'c', type: 'chart', configuration: {} }, { schema: s, pills: true, hasCovers: false }, ctx()), null); // no x axis
	assert.equal(convertView({ name: 'f', type: 'form', configuration: {} }, { schema: s, pills: true, hasCovers: false }, ctx()), null);
	const ch = convertView({ name: 'C', type: 'chart', configuration: { chart_type: 'donut', x_axis: { property_id: 'st' }, y_axis: { aggregator: 'count' } } }, { schema: s, pills: true, hasCovers: false }, ctx()) as any;
	assert.equal(ch.type, 'notion-chart'); assert.equal(ch.chartType, 'donut'); assert.match(ch.x, /^note\./);
	const cal = convertView({ name: 'K', type: 'calendar', configuration: { date_property_id: 'dt' } }, { schema: s, pills: true, hasCovers: false }, ctx()) as any;
	if (cal) { assert.equal(cal.type, 'notion-calendar'); assert.match(cal.date, /^note\./); }
});

test('chart renderer counts values', () => {
	const spec = parseSpec('source: X\ntitle: T\nchart: donut\nx: Status\ncolors:\n  Todo: red\n  Done: green');
	assert.equal(spec.colors.Todo, 'red');
	const html = toHtml(renderChart(spec, [{ name: 'a', path: 'a', props: { Status: 'Todo' } }, { name: 'b', path: 'b', props: { Status: 'Todo' } }, { name: 'c', path: 'c', props: { Status: 'Done' } }]));
	assert.match(html, /Todo {2}2/);
	assert.match(html, /#d44c47/);
});

test('end-to-end on the synthetic fixture workspace (test/synthetic-workspace.ts)', () => {
	const res = convertSnapshot(loadSnapshot());
	assert.ok(res.files.length > 60);
	const allowed = new Set(['table', 'cards', 'list', 'kanban', 'notion-chart', 'notion-calendar', 'notion-form']);
	let views = 0, blocks = 0;
	for (const f of res.files) {
		assert.ok(!/X-Amz-|undefined|\[object Object\]/.test(f.content), `bad content in ${f.path}`);
		if (f.path.endsWith('.base')) {
			const doc = YAML.parse(f.content);
			assert.ok(doc.views.length >= 1, f.path);
			for (const v of doc.views) { assert.ok(allowed.has(v.type), v.type); views++; }
		} else {
			assert.ok(f.content.startsWith('---\n'), f.path);
			const fm = f.content.split('\n---\n')[0].slice(4);
			assert.doesNotThrow(() => YAML.parse(fm), f.path);
			for (const m of f.content.matchAll(/^```base\n([\s\S]*?)\n```/gm)) { const d = YAML.parse(m[1]); assert.ok(d.views.length); blocks++; }
		}
	}
	assert.ok(views >= 15 && blocks >= 10, `views=${views} blocks=${blocks}`);
	for (const a of res.assets) assert.ok(a.path.startsWith('Notion/_attachments/'));
});

// ---------------------------------------------------------------- live formulas
import { compileFormulas, parseFormula, Emitter, noteRef } from '../src/core/formula.ts';

const fds = {
	properties: {
		Name: { id: 'title', type: 'title', title: {} },
		Status: { id: 'st', type: 'status', status: { options: [] } },
		N: { id: 'n', type: 'number', number: {} },
		D: { id: 'd', type: 'date', date: {} },
		Tags: { id: 'tg', type: 'multi_select', multi_select: { options: [] } },
		Tasks: { id: 'tk', type: 'relation', relation: { data_source_id: 'tasks-ds' } },
		Done: { id: 'dn', type: 'rollup', rollup: { relation_property_id: 'tk', rollup_property_id: 'ck', function: 'percent_checked' } },
		F1: { id: 'f1', type: 'formula', formula: { expression: 'ifs(prop("Status") == "Archived", "A", prop("Done") == 1, "D", "N")' } },
		F2: { id: 'f2', type: 'formula', formula: { expression: 'if(empty(prop("D")), "", formatDate(prop("D"), "YYYY"))' } },
		F3: { id: 'f3', type: 'formula', formula: { expression: 'style(repeat("■", round(prop("N") * 10)), "b", "green")' } },
		F4: { id: 'f4', type: 'formula', formula: { expression: 'prop("Tags").format().contains("x") and not prop("N") > 3' } },
		F5: { id: 'f5', type: 'formula', formula: { expression: 'sqrt(prop("N"))' } },
		F6: { id: 'f6', type: 'formula', formula: { expression: 'let(x, prop("N") * 2, x + 1)' } },
		F7: { id: 'f7', type: 'formula', formula: { expression: 'dateBetween(now(), prop("D"), "days") <= 183' } },
	},
};
const tasksDs = { properties: { Name: { id: 'title', type: 'title', title: {} }, Check: { id: 'ck', type: 'checkbox', checkbox: {} } } };

test('formula parser: precedence, methods, and/or/not, ternary', () => {
	const n: any = parseFormula('prop("A").length() > 0 and 1 + 2 * 3 == 7 ? "y" : "n"');
	assert.equal(n.k, 'call'); assert.equal(n.fn, 'if');
	assert.equal(n.args[0].op, '&&');
});

test('formulas → live Bases expressions; unsupported → static with reason', () => {
	const s = schemaOf(fds);
	const look = { schema: (id: string) => (id === 'tasks-ds' ? schemaOf(tasksDs) : undefined) };
	const { live, report } = compileFormulas('T', s, look);
	const it = 'if(note["Tasks"].isEmpty(), [], list(note["Tasks"])).filter(value.isType("link")).filter(value.asFile())';
	assert.equal(live.get('Done')!.expr, `if(${it}.length == 0, null, ${it}.filter(value.asFile().properties["Check"] == true).length / ${it}.length)`);
	assert.equal(live.get('Done')!.display, 'Done_pct');
	assert.equal(live.get('F1')!.expr, 'if(note["Status"] == "Archived", "A", if(formula.Done == 1, "D", "N"))');
	assert.equal(live.get('F2')!.expr, 'if(date(note["D"]).isEmpty(), "", date(note["D"]).format("YYYY"))');
	assert.match(live.get('F3')!.expr, /^html\("<span class='n-style n-f-b n-c-green'>" \+ escapeHTML\("■"\.repeat/);
	assert.equal(live.get('F4')!.expr, 'if(note["Tags (Notion)"].isEmpty(), [], note["Tags (Notion)"]).join(",").contains("x") && (!(if(note["N"].isEmpty(), 0, note["N"]) > 3))');
	assert.equal(live.has('F5'), false);
	assert.match(report.find(r => r.property === 'F5')!.reason!, /sqrt/);
	assert.equal(live.get('F6')!.expr, '(if(note["N"].isEmpty(), 0, note["N"]) * 2) + 1');
	assert.match(live.get('F7')!.expr, /^if\(\(now\(\) - date\(note\["D"\]\)\)\.days < 0/);
	assert.equal(noteRef({ name: 'X', type: 'checkbox' }).code, '(note["X"] == true)');
	assert.ok(Emitter);
});

test('fixtures: Home Hub Projects formulas are live, not stored in notes; views use formula.*', () => {
	const res = convertSnapshot(loadSnapshot());
	const live = res.formulaReport.filter(e => e.live).map(e => `${e.db}.${e.property}`);
	for (const k of ['Projects.Auto Status', 'Projects.Completion', 'Projects.Progress', 'Projects.Resource States', 'Books.Progress bar', 'Authors.Book count']) assert.ok(live.includes(k), k);
	const base = res.files.find(f => f.path.endsWith('Home Hub/Databases/Projects/Projects.base'))!;
	const doc = YAML.parse(base.content);
	assert.match(doc.formulas.Auto_Status, /formula\.Resource_States/);
	assert.ok(doc.views.some((v: any) => v.groupBy?.property === 'formula.Auto_Status'));
	assert.ok(doc.views[0].order.includes('formula.Auto_Status'));
	assert.match(base.content, /^# notion-icon: 📁$/m);
	const row = res.files.find(f => f.path.includes('Home Hub/Databases/Projects/') && f.path.endsWith('.md'))!;
	assert.doesNotMatch(row.content, /^(Auto Status|Completion|Progress|Resource States):/m);
	assert.match(row.content, /^notion-icon: /m);
	assert.equal(res.baseIcons[base.path], '📁');
});

test('view tabs: Notion view order, linked views keep only their own views, chart/calendar inside the base', () => {
	const res = convertSnapshot(loadSnapshot());
	const base = res.files.find(f => f.path.endsWith('Home Hub/Databases/Projects/Projects.base'))!;
	const doc = YAML.parse(base.content);
	assert.deepEqual(doc.views.map((v: any) => v.name), ['All', 'By Status', 'By Area']);
	assert.equal(doc.notion.icon, '📁');
	assert.ok(doc.notion.database && doc.notion['data-source']);
	const blocks = res.files.flatMap(f => [...f.content.matchAll(/^```base\n([\s\S]*?)\n```/gm)].map(m => YAML.parse(m[1])));
	const names = blocks.map(b => b.views.map((v: any) => v.name).join('|'));
	assert.ok(names.includes('Overview|By Status|By Area'), 'Home Hub Projects linked view');
	assert.ok(names.includes('All|By category|Finished|To read|Paused|Table'), 'Reading List books linked view');
	const charts = blocks.find(b => b.views.some((v: any) => v.name === 'Category chart'))!;
	assert.deepEqual(charts.views.map((v: any) => v.type), ['notion-chart', 'notion-chart']);
	const cal = blocks.find(b => b.views.some((v: any) => v.name === 'This Week'))!;
	assert.deepEqual(cal.views.map((v: any) => [v.type, v.range]), [['notion-calendar', 'week'], ['notion-calendar', 'month']]);
	assert.ok(!res.files.some(f => /```notion-(chart|calendar)/.test(f.content)), 'no separate chart/calendar code blocks any more');
	// Tasks: form view kept as a "new row" form view, in Notion's order
	const tasks = YAML.parse(res.files.find(f => f.path.endsWith('/Tasks/Tasks.base'))!.content);
	assert.deepEqual(tasks.views.map((v: any) => [v.name, v.type]), [['All', 'table'], ['➕ New task', 'notion-form'], ['Unscheduled', 'table']]);
	const form = tasks.views[1];
	assert.equal(form.fields[0].key, 'file.name');
	assert.ok(form.folder.endsWith('/Tasks'));
});

// Round 5 bug: relations keep links to non-imported pages as https://www.notion.so/<id> URLs; Bases throws
// "Cannot find function asFile on type URL" if a formula dereferences them. Every asFile() on a relation item
// must sit behind value.isType("link").
test('rollups/formulas never call asFile() on a relation item that may be a URL', () => {
	const ds = { properties: {
		Name: { id: 'title', type: 'title', title: {} },
		Res: { id: 'rs', type: 'relation', relation: { data_source_id: 'res-ds' } },
		St: { id: 's1', type: 'rollup', rollup: { relation_property_id: 'rs', rollup_property_id: 'st', function: 'show_original' } },
		Cnt: { id: 's2', type: 'rollup', rollup: { relation_property_id: 'rs', rollup_property_id: 'st', function: 'count' } },
		Pct: { id: 's3', type: 'rollup', rollup: { relation_property_id: 'rs', rollup_property_id: 'ck', function: 'percent_checked' } },
		Sub: { id: 's4', type: 'rollup', rollup: { relation_property_id: 'rs', rollup_property_id: 'rl', function: 'show_original' } },
		Txt: { id: 'f1', type: 'formula', formula: { expression: 'format(prop("Res"))' } },
		Has: { id: 'f2', type: 'formula', formula: { expression: 'prop("St").format().contains("Done")' } },
	} };
	const resDs = { properties: { Name: { id: 'title', type: 'title', title: {} }, Status: { id: 'st', type: 'status', status: { options: [] } },
		Ck: { id: 'ck', type: 'checkbox', checkbox: {} }, Rel: { id: 'rl', type: 'relation', relation: { data_source_id: 'x' } } } };
	const { live } = compileFormulas('P', schemaOf(ds), { schema: (id: string) => (id === 'res-ds' ? schemaOf(resDs) : undefined) });
	assert.equal(live.size, 6);
	for (const [name, f] of live) {
		// a relation list may only reach asFile() through the isType("link") guard
		assert.ok(!/list\(note\["Res"\]\)\)\.(map|filter)\(value\.asFile/.test(f.expr), `${name} dereferences relation items unguarded: ${f.expr}`);
		assert.ok(!f.expr.includes('.map(value.asFile().name)'), `${name}: ${f.expr}`);
		if (f.expr.includes('value.asFile()')) assert.ok(f.expr.includes('isType("link")'), `${name} dereferences without guard: ${f.expr}`);
	}
	// count counts every related page (also the ones kept as URLs), like Notion
	assert.equal(live.get('Cnt')!.expr, 'if(note["Res"].isEmpty(), [], list(note["Res"])).length');
	assert.match(live.get('Txt')!.expr, /isType\("link"\) && value\.asFile\(\), value\.asFile\(\)\.name, value\.toString\(\)/);
});

test('status pills carry Notion\'s status style (dot), select pills do not; default colour is still a pill', async () => {
	const { pillFormula } = await import('../src/core/views.ts');
	const st = pillFormula({ id: 's', name: 'Status', type: 'status', status: { options: [{ name: 'Not started', color: 'default' }, { name: 'Done', color: 'green' }] } });
	assert.match(st, /n-pill n-pill-status n-pill-/);
	assert.match(st, /"Not started", "default"/);
	const se = pillFormula({ id: 'x', name: 'Kind', type: 'select', select: { options: [{ name: 'A', color: 'default' }] } });
	assert.ok(!se.includes('n-pill-status'));
});

test('Notion table column widths → Bases columnSize with prefixed keys', async () => {
	const { convertView, schemaOf } = await import('../src/core/views.ts');
	const { Ctx } = await import('../src/core/context.ts');
	const { DEFAULT_OPTIONS } = await import('../src/core/types.ts');
	const schema = schemaOf({ properties: { Name: { id: 'title', type: 'title', title: {} }, Status: { id: 'st', type: 'status', status: { options: [{ name: 'A', color: 'red' }] } }, Memo: { id: 'mm', type: 'rich_text', rich_text: {} } } });
	const v = convertView({ type: 'table', name: 'T', configuration: { properties: [
		{ property_id: 'title', visible: true, width: 280 }, { property_id: 'st', visible: true, width: 120, wrap: true }, { property_id: 'mm', visible: true, width: 333 }, { property_id: 'mm', visible: false, width: 50 } ] } },
		{ schema, pills: true, hasCovers: false }, new Ctx({ ...DEFAULT_OPTIONS }))!;
	const size = v.columnSize as Record<string, number>;
	assert.equal(size['file.name'], 280);
	assert.equal(size['note.Memo'], 333);
	assert.ok(Object.keys(size).some(k => k.startsWith('formula.pill_') && size[k] === 120));
});
