/* eslint-disable @typescript-eslint/no-explicit-any */
// Round 4: data-loss audit. One test per issue found (see NOTES.md "Round 4").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';
import { NotionCrawler } from '../src/api/crawler.ts';
import { convertSnapshot } from '../src/core/convert.ts';
import { renderBlocks } from '../src/core/blocks.ts';
import { Ctx, collectFileUrls } from '../src/core/context.ts';
import { richText } from '../src/core/richtext.ts';
import { propertyValue } from '../src/core/properties.ts';
import { planSync, contentHash, type Manifest } from '../src/core/backup.ts';
import { DEFAULT_OPTIONS } from '../src/core/types.ts';
import { isoToLocal, sanitizeFileName } from '../src/core/util.ts';
import { runBackup, rebuildFromRaw } from '../src/pipeline.ts';
import { loadSnapshot } from '../scripts/load-fixtures.ts';
import { FakeNotion, MemVault, okFetcher, rt, uid } from './fake-notion.ts';

const noSleep = async () => {};
const crawl = (f: FakeNotion, o: any = {}) => new NotionCrawler(f.transport, { rootIds: [], minInterval: 0, sleep: noSleep, ...o }).run();
const ctx = () => new Ctx({ ...DEFAULT_OPTIONS, timeZone: 'Asia/Shanghai' });
const fm = (content: string) => YAML.parse(content.split('\n---\n')[0].slice(4));

// ------------------------------------------------------------------ crawler coverage

test('#1 relation with >25 items is completed through the property-item endpoint (was: silently cut to 25)', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	const { ds: target } = f.database(root.id, 'Quotes', { Name: { id: 'title', type: 'title', title: {} } });
	const quotes = Array.from({ length: 39 }, (_, i) => f.addRow(target.id, 'q' + i, {}));
	const { ds } = f.database(root.id, 'Books', { Name: { id: 'title', type: 'title', title: {} }, 摘录: { id: 'KU%40F', type: 'relation', relation: { data_source_id: target.id } } });
	const book = f.addRow(ds.id, 'Book', { 摘录: { id: 'KU%40F', type: 'relation', relation: quotes.slice(0, 25).map(q => ({ id: q.id })), has_more: true } });
	f.propItems[`${book.id}/KU@F`] = quotes.map(q => ({ object: 'property_item', type: 'relation', id: 'KU%40F', relation: { id: q.id } }));
	const snap = await crawl(f);
	const row = Object.values(snap.databases).flatMap(d => d.data_sources).flatMap(d => d.rows).find(r => r.id === book.id);
	assert.equal(row.properties['摘录'].relation.length, 39);
	assert.equal(snap.stats!.paginatedProperties, 1);
	const res = convertSnapshot(snap);
	const note = res.files.find(x => x.path.endsWith('/Books/Book.md'))!;
	assert.equal(fm(note.content)['摘录'].length, 39);
});

test('#2 >100 children, >100 rows, deep nesting, pages inside toggles/columns, synced blocks: all fetched', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	for (let i = 0; i < 230; i++) f.block(root.id, 'paragraph', { rich_text: rt('p' + i) });
	let parent = f.block(root.id, 'toggle', { rich_text: rt('d0') });
	for (let d = 1; d < 20; d++) { const b = f.block(parent.id, 'toggle', { rich_text: rt('d' + d) }); parent.has_children = true; parent = b; }
	const col = f.block(root.id, 'column_list', {}); col.has_children = true;
	const c1 = f.block(col.id, 'column', {}); c1.has_children = true;
	const inCol = f.childPage(root.id, 'Page in column', c1.id);
	const tg = f.block(root.id, 'toggle', { rich_text: rt('t') }); tg.has_children = true;
	f.childPage(root.id, 'Page in toggle', tg.id);
	const orig = f.block(root.id, 'synced_block', { synced_from: null }); orig.has_children = true;
	f.block(orig.id, 'paragraph', { rich_text: rt('synced text') });
	const other = f.childPage(root.id, 'Other');
	const ref = f.block(other.id, 'synced_block', { synced_from: { type: 'block_id', block_id: orig.id } }); ref.has_children = true;
	const { ds } = f.database(root.id, 'Big', { Name: { id: 'title', type: 'title', title: {} } });
	for (let i = 0; i < 260; i++) f.addRow(ds.id, 'r' + i, {});
	const snap = await crawl(f, { rowBodies: false });
	assert.equal(snap.complete, true, (snap.errors || []).join('\n'));
	assert.equal(snap.pages[root.id].blocks.filter(b => b.type === 'paragraph').length, 230);
	assert.ok(snap.pages[inCol.id], 'child page inside a column');
	assert.ok(Object.values(snap.pages).some(p => p.page.properties.title.title[0].plain_text === 'Page in toggle'));
	assert.equal(snap.pages[other.id].blocks[0].children![0].paragraph.rich_text[0].plain_text, 'synced text');
	assert.equal(Object.values(snap.databases)[0].data_sources[0].rows.length, 260);
	const res = convertSnapshot(snap);
	const rootMd = res.files.find(x => x.path === 'Notion/Root.md')!.content;
	assert.match(rootMd, /d19/);
	assert.equal(res.files.filter(x => x.path.startsWith('Notion/Root/Big/') && x.path.endsWith('.md')).length, 260);
});

test('#3 429 (Retry-After), 5xx and network errors are retried; a failing request is reported, never silent', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	f.block(root.id, 'paragraph', { rich_text: rt('x') });
	const child = f.childPage(root.id, 'Child');
	f.block(child.id, 'paragraph', { rich_text: rt('y') });
	f.failOnce.set(`/blocks/${root.id}`, 429);
	f.failOnce.set(`/pages/${child.id}`, 'throw');
	let slept = 0;
	const snap = await crawl(f, { sleep: async (ms: number) => { slept += ms; } });
	assert.equal(snap.complete, true);
	assert.ok(snap.pages[child.id]);
	assert.ok(slept >= 1000);
	// permanent error → recorded + crawl marked incomplete
	const g = new FakeNotion();
	const r2 = g.page('Root', { type: 'workspace', workspace: true });
	const t = g.block(r2.id, 'toggle', { rich_text: rt('t') }); t.has_children = true; delete g.children[t.id];
	const s2 = await crawl(g);
	assert.equal(s2.complete, false);
	assert.match(s2.errors!.join('\n'), /blocks of/);
});

test('#4 pages shared on their own / under blocks / rows of a database without access are not lost', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	const hidden = uid();   // a block the integration cannot open
	const lone = f.page('Lonely', { type: 'block_id', block_id: hidden });
	const row = f.page('Row of hidden db', { type: 'data_source_id', data_source_id: uid() }, {});
	row.properties.Score = { id: 's', type: 'number', number: 7 };
	const snap = await crawl(f);
	assert.ok(snap.pages[lone.id] && snap.pages[row.id]);
	const res = convertSnapshot(snap);
	assert.ok(res.files.some(x => x.path === 'Notion/_Unsorted/Lonely.md'));
	const r = res.files.find(x => x.path.endsWith('Row of hidden db.md'))!;
	assert.equal(fm(r.content).Score, 7);
	assert.equal(res.audit.orphansPlaced, 2);
	void root;
});

test('#5 comments: page + block comments backed up and rendered; missing capability reported loudly', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	const p = f.block(root.id, 'paragraph', { rich_text: rt('commented line') });
	f.comments[root.id] = [{ object: 'comment', id: 'c1', discussion_id: 'd1', parent: { type: 'page_id', page_id: root.id }, created_time: '2026-11-01T02:00:00.000Z', created_by: { object: 'user', id: 'u1' }, rich_text: rt('page note') }];
	f.comments[p.id] = [{ object: 'comment', id: 'c2', discussion_id: 'd2', parent: { type: 'block_id', block_id: p.id }, created_time: '2026-11-01T03:00:00.000Z', created_by: { object: 'user', id: 'u1' }, rich_text: rt('block note'), attachments: [{ category: 'image', file: { url: 'https://prod-files-secure.s3.amazonaws.com/a/b/shot.png?X-Amz-Signature=1', expiry_time: 'x' } }] }];
	const snap = await crawl(f);
	assert.equal(snap.stats!.comments, 2);
	const res = convertSnapshot(snap, { timeZone: 'Asia/Shanghai' });
	const md = res.files.find(x => x.path === 'Notion/Root.md')!.content;
	assert.match(md, /\[!notion-comments\]- 💬 评论 \(2\)/);
	assert.match(md, /\*\*Me\*\* <span class="n-comment-time">2026-11-01 10:00<\/span>/);
	assert.match(md, /> > commented line/);
	assert.match(md, /_attachments\/shot-/);
	assert.equal(res.audit.commentsRendered, 2);
	const g = new FakeNotion(); g.page('Root', { type: 'workspace', workspace: true }); g.commentsForbidden = true;
	const s2 = await crawl(g);
	assert.match(s2.errors!.join(), /Read comments/);
});

// ------------------------------------------------------------------ block / rich text / property fidelity

const blk = (type: string, data: any, children?: any[]) => ({ id: uid(), type, [type]: data, has_children: !!children, children });

test('#6 every block type of the API renders; unknown blocks are visible with their text and children (never dropped)', () => {
	const c = ctx();
	const all = [
		blk('paragraph', { rich_text: rt('p') }), blk('heading_1', { rich_text: rt('h1') }), blk('heading_2', { rich_text: rt('h2'), is_toggleable: true }, [blk('paragraph', { rich_text: rt('in h2') })]),
		blk('heading_3', { rich_text: rt('h3') }, [blk('paragraph', { rich_text: rt('kept under ex-toggle heading') })]),
		blk('bulleted_list_item', { rich_text: rt('b') }), blk('numbered_list_item', { rich_text: rt('n') }), blk('to_do', { rich_text: rt('t'), checked: true }),
		blk('toggle', { rich_text: rt('tg') }, [blk('paragraph', { rich_text: rt('in toggle') })]), blk('quote', { rich_text: rt('q') }), blk('callout', { rich_text: rt('c'), icon: { type: 'emoji', emoji: '💡' }, color: 'blue_background' }),
		blk('code', { rich_text: rt('x = 1'), language: 'python', caption: rt('cap') }), blk('equation', { expression: 'e=mc^2' }), blk('divider', {}),
		blk('table', { table_width: 2, has_column_header: true, has_row_header: true }, [blk('table_row', { cells: [rt('a'), rt('b')] }), blk('table_row', { cells: [rt('c'), rt('d')] })]),
		blk('column_list', {}, [blk('column', {}, [blk('paragraph', { rich_text: rt('col') })])]),
		blk('synced_block', { synced_from: null }, [blk('paragraph', { rich_text: rt('synced') })]),
		blk('template', { rich_text: rt('Add task') }, [blk('to_do', { rich_text: rt('templated todo'), checked: false })]),
		blk('link_to_page', { type: 'page_id', page_id: '11111111-1111-1111-1111-111111111111' }), blk('child_page', { title: 'Not shared' }),
		blk('child_database', { title: 'No access DB' }), blk('bookmark', { url: 'https://example.com', caption: [] }), blk('embed', { url: 'https://example.com/e' }),
		blk('link_preview', { url: 'https://github.com/x' }),
		blk('image', { type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/s/i/pic.png?sig=1' }, caption: rt('img cap') }),
		blk('video', { type: 'external', external: { url: 'https://youtu.be/x' }, caption: [] }), blk('audio', { type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/s/a/a.mp3?s' }, caption: [] }),
		blk('file', { type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/s/f/doc.zip?s' }, caption: [], name: 'doc.zip' }), blk('pdf', { type: 'external', external: { url: 'https://x.org/a.pdf' }, caption: [] }),
		blk('breadcrumb', {}), blk('table_of_contents', { color: 'default' }),
		blk('unsupported', { block_type: 'form' }), blk('meeting_notes', { title: rt('Weekly sync') }, [blk('paragraph', { rich_text: rt('summary text') })]),
	];
	const md = renderBlocks(all, c).join('\n');
	for (const s of ['in h2', 'kept under ex-toggle heading', 'templated todo', 'col', 'synced', '```python', 'e=mc^2', '| a | b |', 'pic-', 'doc-', 'a.pdf', 'Weekly sync', 'summary text', 'unsupported:form', 'https://www.notion.so/11111111111111111111111111111111', 'No access DB', '[Not shared](https://www.notion.so/']) assert.ok(md.includes(s), s);
	const ids = new Set<string>();
	const walk = (bs: any[]) => bs.forEach(b => { ids.add(b.id); walk(b.children || []); });
	walk(all);
	for (const id of ids) assert.ok(c.audit.renderedBlocks.has(id), 'block not accounted for: ' + id);
	assert.deepEqual(Object.keys(c.audit.unsupportedBlocks).sort(), ['meeting_notes', 'unsupported:form']);
});

test('#7 literal text stays literal (CommonMark render == Notion text) with only the escapes that are needed (round 6)', () => {
	const c = ctx();
	const cases = [
		'price $5 and $6, <div> tag, *not italic*, [[not link]], %%hidden%%, ==mark==, #tag, a_b_c, see https://ex.com/a_b',
		'only one dollar: $5 a month', 'a < b and c > d', 'snake_case_name and 中_文', 'a * b * c', 'file_name.txt', 'a * b', '* star item', 'x ~ y', 'C:\\Users\\me', 'path\\*star',
		'about 3~5 days', '~~not struck~~', '[x](https://example.com) and ![img](a.png) and [^1]', 'one ` backtick', 'two `x` ticks',
		'50% off, 100%% sure', 'a == b', 'C# and F#', 'ends with ^block-id', '&amp; stays &amp;', '_lead and trail_', '*', '_', '[', ']',
	];
	const blocks = cases.map(t => blk('paragraph', { rich_text: rt(t) }));
	const out = renderBlocks([...blocks, blk('paragraph', { rich_text: rt('1. not a list') }), blk('paragraph', { rich_text: rt('# not a heading') }),
		blk('paragraph', { rich_text: rt('    not code') }), blk('paragraph', { rich_text: rt('---') }), blk('bulleted_list_item', { rich_text: rt('[ ] not a checkbox') })], c);
	const md = out.join('\n');
	// (1) CommonMark: rendered text is exactly the Notion text (emphasis, links, HTML, code spans, entities, escapes)
	const mdit = new MarkdownIt({ html: true, linkify: false });
	const text = (s: string) => mdit.render(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;|\u00a0/g, ' ').trim();
	const paras = md.split('\n\n');
	cases.forEach((t, i) => assert.equal(text(paras[i]), t, `CommonMark: ${JSON.stringify(t)} → ${JSON.stringify(paras[i])}`));
	// (2) Obsidian-only syntax: nothing unescaped is left that Obsidian would turn into math, wikilinks, highlights,
	// comments, tags or block ids
	for (const p of paras.slice(0, cases.length)) {
		const bare = p.replace(/\\./g, 'X');                    // escaped characters are inert
		assert.ok(!/\[\[|%%/.test(bare), 'obsidian syntax left in ' + p);
		assert.ok((bare.match(/==/g) || []).length < 2 && (bare.match(/~~/g) || []).length < 2, 'highlight/strike pair left in ' + p);
		assert.ok((bare.match(/\*/g) || []).length < 2 && (bare.match(/_/g) || []).length < 2, 'emphasis pair left in ' + p);
		assert.ok((bare.match(/\$/g) || []).length < 2, 'math pair left in ' + p);
		assert.ok(!/(^|\s)#[^\s#]/.test(bare), 'tag left in ' + p);
		assert.ok(!/\s\^[A-Za-z0-9-]+\s*$/.test(bare), 'block id left in ' + p);
	}
	// (3) minimal escaping: these need no backslash at all any more (they showed as "\$5" etc. in Live Preview)
	for (const t of ['only one dollar: $5 a month', 'a < b and c > d', 'file_name.txt', 'a * b', 'about 3~5 days', 'one ` backtick', 'a == b', 'C# and F#'])
		if (cases.includes(t)) assert.ok(!paras[cases.indexOf(t)].includes('\\'), 'unneeded escape in ' + paras[cases.indexOf(t)]);
	assert.ok(paras[0].startsWith('price \\$5 and \\$6, \\<div> tag, \\*not italic\\*, \\[[not link\\]], \\%\\%hidden\\%\\%, \\=\\=mark\\=\\=, \\#tag, a\\_b\\_c, see https://ex.com/a_b'), paras[0]);
	assert.match(md, /^1\\\. not a list$/m);
	assert.match(md, /^\\# not a heading$/m);
	assert.match(md, /^&nbsp;&nbsp;&nbsp;&nbsp;not code$/m);
	assert.match(md, /^\\---$/m);
	assert.match(md, /^- \\\[ \] not a checkbox$/m);
	// a lone $ next to an inline equation is escaped (it would pair with the equation's delimiter)
	assert.equal(richText([...rt('costs $5 '), { type: 'equation', equation: { expression: 'x' }, plain_text: 'x', annotations: {} }], c), 'costs \\$5 $x$');
	// code spans keep their text verbatim, backticks inside use a longer fence
	assert.equal(richText([{ type: 'text', text: { content: 'a`b' }, plain_text: 'a`b', annotations: { code: true } }], c), '`` a`b ``');
	// property values are not escaped
	assert.equal(propertyValue({ type: 'rich_text', rich_text: rt('$5 *x*') }, c), '$5 *x*');
});

test('#8 mentions: page outside the import, dates with time/range/zone, template mentions, users', () => {
	const c = ctx();
	const m = (mention: any, plain = 'x') => ({ type: 'mention', mention, plain_text: plain, annotations: {}, href: null });
	const md = richText([
		m({ type: 'page', page: { id: '22222222-2222-2222-2222-222222222222' } }, 'Secret page'), { type: 'text', text: { content: ' ' }, plain_text: ' ', annotations: {} },
		m({ type: 'date', date: { start: '2026-11-07T10:00:00.000+08:00', end: '2026-11-08T12:30:00.000+08:00', time_zone: null } }),
		m({ type: 'date', date: { start: '2026-11-07T02:00:00.000Z', end: null } }),
		m({ type: 'template_mention', template_mention: { type: 'template_mention_date', template_mention_date: 'today' } }),
		m({ type: 'user', user: { id: 'u9', name: 'Ann' } }, '@Ann'),
	], c);
	assert.match(md, /\[Secret page\]\(https:\/\/www\.notion\.so\/22222222222222222222222222222222\)/);
	assert.match(md, /@2026-11-07 10:00 → 2026-11-08 12:30/);
	assert.match(md, /@2026-11-07 10:00<\/span>/);   // UTC → Asia/Shanghai
	assert.match(md, /@today/);
	assert.match(md, /@Ann/);
});

test('#9 properties: UTC times in local zone, seconds + range + zone kept, unresolved relations kept as URL, unknown types as JSON', () => {
	const c = ctx();
	assert.equal(isoToLocal('2026-11-07T02:00:00.000Z', 'Asia/Shanghai'), '2026-11-07T10:00');
	assert.equal(isoToLocal('2026-11-07T10:00:30.000+08:00', 'Asia/Shanghai'), '2026-11-07T10:00:30');
	assert.equal(propertyValue({ type: 'created_time', created_time: '2026-11-06T23:30:00.000Z' }, c), '2026-11-07T07:30');
	assert.deepEqual(propertyValue({ type: 'relation', relation: [{ id: '33333333-3333-3333-3333-333333333333' }] }, c), ['https://www.notion.so/33333333333333333333333333333333']);
	assert.equal(propertyValue({ type: 'place', place: { name: 'Hefei', lat: 31.8, lon: 117.2 } }, c), 'Hefei @ 31.8,117.2');
	assert.equal(propertyValue({ type: 'future_thing', future_thing: { a: 1 } }, c), '{"a":1}');
	assert.equal(c.audit.propsFallback.future_thing, 1);
	assert.deepEqual(propertyValue({ type: 'files', files: [{ name: 'x.pdf', type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/s/x.pdf?sig' } }] }, c), ['[[Notion/_attachments/x-' + c.assets.values().next().value!.path.split('/x-')[1] + ']]']);
	assert.equal(propertyValue({ type: 'number', number: 0.1 + 0.2 }, c), 0.30000000000000004);
});

test('#10 duplicate titles: two same-named pages each keep their own sub-pages; illegal / long / reserved names', () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	const a = f.childPage(root.id, 'Notes'); const b = f.childPage(root.id, 'notes');
	f.childPage(a.id, 'A child'); f.childPage(b.id, 'B child');
	return crawl(f).then(snap => {
		const res = convertSnapshot(snap);
		const paths = res.files.map(x => x.path);
		assert.ok(paths.includes('Notion/Root/Notes.md') && paths.includes('Notion/Root/notes (2).md'));
		assert.ok(paths.includes('Notion/Root/Notes/A child.md'));
		assert.ok(paths.includes('Notion/Root/notes (2)/B child.md'), paths.join('\n'));
		assert.equal(sanitizeFileName('a/b:c?'), 'a b c');
		assert.equal(sanitizeFileName('CON'), '_CON');
		assert.equal(sanitizeFileName('trailing...'), 'trailing');
		assert.ok(new TextEncoder().encode(sanitizeFileName('长'.repeat(300))).length <= 153);
		const long = '长'.repeat(300);
		const g = new FakeNotion(); g.page(long, { type: 'workspace', workspace: true });
		return crawl(g).then(s2 => { const r2 = convertSnapshot(s2); assert.equal(fm(r2.files[0].content)['notion-title'], long); });
	});
});

test('#11 fixtures: Reading List books with the same title are both kept, every row / block accounted for, metadata in frontmatter', () => {
	const snap = loadSnapshot();
	const res = convertSnapshot(snap, { timeZone: 'Asia/Shanghai' });
	const rows = Object.values(snap.databases).flatMap(d => d.data_sources).flatMap(d => d.rows);
	const titles = new Map<string, string[]>();
	for (const r of rows) { const t = r.properties && Object.values<any>(r.properties).find(p => p.type === 'title')?.title.map((x: any) => x.plain_text).join(''); const id = r.id.replace(/-/g, ''); titles.set(t, [...new Set([...(titles.get(t) || []), id])]); }
	const dup = [...titles.entries()].find(([, ids]) => ids.length > 1)!;
	assert.ok(dup, 'fixture has duplicate titles');
	for (const id of dup[1]) assert.ok(res.idPaths[id], 'row with duplicate title written: ' + dup[0]);
	assert.notEqual(res.idPaths[dup[1][0]], res.idPaths[dup[1][1]]);
	const unique = new Set(rows.map(r => r.id.replace(/-/g, '')));
	for (const id of unique) assert.ok(res.idPaths[id], 'row missing ' + id);
	const note = res.files.find(x => x.path.endsWith('.md') && x.content.includes('notion-edited'))!;
	const meta = fm(note.content);
	assert.match(meta['notion-url'], /^https:\/\/(www\.notion\.so|app\.notion\.com)\//);
	assert.match(String(meta['notion-created']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
	// every block of every written page is accounted for
	const ids = new Set(Object.keys(res.idPaths));
	let n = 0;
	const walk = (bs: any[]) => bs?.forEach(b => { n++; assert.ok(res.audit.renderedBlocks.has(b.id), b.type + ' ' + b.id); walk(b.children); });
	for (const [id, ps] of Object.entries(snap.pages)) if (ids.has(id.replace(/-/g, ''))) walk(ps.blocks);
	assert.ok(n > 300, String(n));
});

test('#12 files: every Notion-hosted URL inside any object is found (icons, covers, files props, blocks, comment attachments)', () => {
	const urls = collectFileUrls({ icon: { type: 'file', file: { url: 'https://s3/a.png?x' } }, cover: { type: 'external', external: { url: 'https://www.notion.so/images/page-cover/x.jpg' } },
		properties: { F: { type: 'files', files: [{ name: 'f', type: 'file', file: { url: 'https://s3/b.pdf?x' } }, { name: 'e', type: 'external', external: { url: 'https://ex.com/e.png' } }] } },
		blocks: [{ type: 'image', image: { type: 'file_upload', file_upload: { url: 'https://s3/c.png?x' } } }], comments: { b: [{ attachments: [{ category: 'image', file: { url: 'https://s3/d.png?x', expiry_time: 'x' } }] }] } });
	assert.deepEqual(urls.sort(), ['https://s3/a.png?x', 'https://s3/b.pdf?x', 'https://s3/c.png?x', 'https://s3/d.png?x', 'https://www.notion.so/images/page-cover/x.jpg']);
	assert.ok(collectFileUrls({ type: 'external', external: { url: 'https://ex.com/e.png' } }, [], true).includes('https://ex.com/e.png'));
});

// ------------------------------------------------------------------ re-sync

test('#13 re-sync plan: untouched → overwrite, local edit → backup first, rename → move, removed → archive (only if complete + same scope)', () => {
	const prev: Manifest = { version: 1, startedAt: '', complete: true, scope: [], assets: {},
		files: { 'N/a.md': { hash: contentHash('A1') }, 'N/b.md': { hash: contentHash('B1') }, 'N/old.md': { hash: contentHash('C1') }, 'N/gone.md': { hash: contentHash('G') } },
		ids: { a: 'N/a.md', b: 'N/b.md', c: 'N/old.md', g: 'N/gone.md' } };
	const vault: Record<string, string> = { 'N/a.md': 'A1', 'N/b.md': 'B1 + my local edit', 'N/old.md': 'C1', 'N/gone.md': 'G' };
	const files = [{ path: 'N/a.md', content: 'A2' }, { path: 'N/b.md', content: 'B2' }, { path: 'N/new name.md', content: 'C2' }];
	const base = { target: 'N', prev, files, idPaths: { a: 'N/a.md', b: 'N/b.md', c: 'N/new name.md' }, read: (p: string) => vault[p] ?? null, scope: [], stamp: 'T' };
	const plan = planSync({ ...base, complete: true });
	// round 8: b changed locally AND in Notion → conflict, default keeps local + saves the Notion version alongside
	assert.deepEqual(plan.backups, []);
	assert.deepEqual(plan.conflicts.map(c => [c.path, c.choice]), [['N/b.md', 'local']]);
	assert.deepEqual(plan.notionCopies, [{ path: 'N/b.md', copy: 'N/_同步冲突/T/b.md' }]);
	assert.deepEqual(plan.renames, [{ from: 'N/old.md', to: 'N/new name.md' }]);
	assert.deepEqual(plan.writes.map(w => w.path), ['N/a.md', 'N/new name.md']);
	const pn = planSync({ ...base, complete: true, resolve: { 'N/b.md': 'notion' } });
	assert.deepEqual(pn.backups, [{ from: 'N/b.md', to: 'N/_本地修改备份/T/b.md' }]);
	assert.deepEqual(pn.writes.map(w => w.path), ['N/a.md', 'N/b.md', 'N/new name.md']);
	assert.deepEqual(plan.archive, [{ from: 'N/gone.md', to: 'N/_已在Notion删除/gone.md' }]);
	assert.deepEqual(planSync({ ...base, complete: false }).archive, []);
	assert.deepEqual(planSync({ ...base, complete: false }).keptMissing, ['N/gone.md']);
	assert.deepEqual(planSync({ ...base, complete: true, scope: ['x'] }).archive, []);
	// first import into a folder that already has a file with that name (no manifest) → backed up, not clobbered
	assert.equal(planSync({ ...base, prev: null, complete: true }).backups.length, 2);
});

function world() {
	const f = new FakeNotion();
	const root = f.page('Home', { type: 'workspace', workspace: true }, { icon: { type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/s/icon.png?X-Amz-Credential=a&X-Amz-Signature=b' } } });
	f.block(root.id, 'paragraph', { rich_text: rt('hello') });
	const a = f.childPage(root.id, 'Alpha'); f.block(a.id, 'paragraph', { rich_text: rt('alpha body') });
	const b = f.childPage(root.id, 'Beta'); f.block(b.id, 'image', { type: 'file', file: { url: 'https://prod-files-secure.s3.amazonaws.com/s/pic.png?X-Amz-Credential=a&X-Amz-Signature=b' }, caption: [] });
	const { ds } = f.database(root.id, 'Tasks', { Name: { id: 'title', type: 'title', title: {} }, Done: { id: 'd', type: 'checkbox', checkbox: {} } }, [['T1', { Done: { id: 'd', type: 'checkbox', checkbox: true } }], ['T2', {}]]);
	return { f, root, a, b, ds };
}
const settings = { target: 'Notion', roots: [], rowBodies: true, comments: 'all' as const, downloadExternal: false, coloredPills: true, staticHeader: false, timeZone: 'Asia/Shanghai', minInterval: 0, sleep: noSleep };

test('#14 pipeline: raw JSON + files saved, verification report, re-sync keeps local edits, archives deleted pages, reuses unchanged pages', async () => {
	const { f, root, a, b } = world();
	const v = new MemVault();
	const r1 = await runBackup(v, f.transport, okFetcher(), settings);
	assert.ok(r1.complete);
	assert.ok(r1.lines.every(l => l.ok), JSON.stringify(r1.lines.filter(l => !l.ok)));
	assert.ok(v.files.has(`Notion/_raw/pages/${root.id.replace(/-/g, '')}.json`));
	assert.ok([...v.files.keys()].some(k => /_attachments\/pic-/.test(k)));
	assert.ok([...v.files.keys()].some(k => /_attachments\/icon-/.test(k)));
	assert.match(await v.read('Notion/_导入报告.md') as string, /校验通过/);
	assert.ok(!v.files.has('Notion/_raw/in-progress.json'));
	for (const [k, c] of v.files) if (typeof c === 'string') assert.doesNotMatch(c, /X-Amz-Signature/, k);

	// local edit + Notion changes: Alpha edited in Notion, Beta deleted, new page added
	await v.write('Notion/Home/Alpha.md', (await v.read('Notion/Home/Alpha.md')) + '\nmy own note\n');
	f.edited = '2026-11-02T00:00:00.000Z';
	f.pages[a.id].last_edited_time = f.edited;
	f.children[a.id][0].paragraph.rich_text = rt('alpha v2');
	delete f.pages[b.id]; f.children[root.id] = f.children[root.id].filter(x => x.id !== b.id);
	f.childPage(root.id, 'Gamma');
	f.calls = [];
	const r2 = await runBackup(v, f.transport, okFetcher(), settings, () => {}, () => false, () => new Date(2026, 10, 8, 9, 30, 0));
	assert.ok(r2.complete, r2.snap.errors!.join('\n'));
	// both sides changed → local kept, Notion version saved under _同步冲突 (round 8)
	assert.match(await v.read('Notion/Home/Alpha.md') as string, /my own note/);
	assert.match(await v.read('Notion/_同步冲突/2026-11-08 093000/Home/Alpha.md') as string, /alpha v2/);
	assert.match(await v.read('Notion/_导入报告.md') as string, /## 变更记录[\s\S]*冲突：保留本地/);
	assert.ok(v.files.has('Notion/_已在Notion删除/Home/Beta.md'));
	assert.ok(v.files.has('Notion/Home/Gamma.md'));
	// unchanged pages were not re-read block by block
	assert.ok(f.calls.some(c => c.startsWith(`GET /blocks/${a.id}/children`)), 'Alpha changed → re-fetched');
	assert.ok(r2.snap.stats!.reusedPages! >= 1);
	// offline rebuild from raw gives the same notes
	const before = await v.read('Notion/Home.md');
	const r3 = await rebuildFromRaw(v, okFetcher(), settings);
	assert.equal(await v.read('Notion/Home.md'), before);
	assert.equal(r3.plan!.archive.length, 0);
});

test('#15 interrupted import: report says incomplete, nothing archived, re-run resumes and completes', async () => {
	const { f } = world();
	const v = new MemVault();
	let n = 0;
	const r1 = await runBackup(v, f.transport, okFetcher(), settings, () => {}, () => ++n > 12);
	assert.equal(r1.complete, false);
	assert.match(await v.read('Notion/_导入报告.md') as string, /导入被取消/);
	const r2 = await runBackup(v, f.transport, okFetcher(), settings);
	assert.ok(r2.complete);
	assert.ok(r2.lines.every(l => l.ok), JSON.stringify(r2.lines.filter(l => !l.ok)));
});

test('#16 failed file downloads and crawl errors are at the top of the report', async () => {
	const { f } = world();
	const v = new MemVault();
	const r = await runBackup(v, f.transport, okFetcher(/pic\.png/), settings);
	const rep = await v.read('Notion/_导入报告.md') as string;
	assert.ok(!r.lines[0].ok);
	assert.match(rep.split('## 2.')[0], /\[!danger\] 发现 1 处不一致[\s\S]*附件[\s\S]*pic\.png[\s\S]*HTTP 403/);
});

test('#17 fidelity: gallery card size + "fit image" follow the Notion view (book galleries were huge cropped cards)', () => {
	const res = convertSnapshot(loadSnapshot());
	const lib = res.files.find(f => f.path === 'Notion/Reading List.md')!.content;
	const m = lib.match(/name: 🕰️ Finished recently[\s\S]*?cardSize: (\d+)/)!;
	assert.equal(m[1], '160');
	assert.match(lib.slice(lib.indexOf('Finished recently')), /imageFit: contain/);
});

test('#18 a request that hangs forever is abandoned and retried (live run showed a stalled connection risk)', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	f.block(root.id, 'paragraph', { rich_text: rt('x') });
	let hung = false;
	const t = async (m: any, p: string, b: any) => { if (!hung && p.startsWith('/blocks/')) { hung = true; return new Promise<any>(() => {}); } return f.transport(m, p, b); };
	const snap = await new NotionCrawler(t, { rootIds: [], minInterval: 0, sleep: noSleep, timeoutMs: 50 }).run();
	assert.ok(hung);
	assert.equal(snap.complete, true);
	assert.equal(snap.pages[root.id].blocks.length, 1);
});

test('#19 offline rebuild keeps the crawl warnings of the run behind the raw store (e.g. comments not backed up)', async () => {
	const { f } = world();
	f.commentsForbidden = true;
	const v = new MemVault();
	await runBackup(v, f.transport, okFetcher(), settings);
	assert.match(await v.read('Notion/_导入报告.md') as string, /Read comments/);
	await rebuildFromRaw(v, okFetcher(), settings);
	assert.match((await v.read('Notion/_导入报告.md') as string).split('## 2.')[0], /Read comments/);
});

// ------------------------------------------------------------------ round 5

test('#20 database templates: listed with GET /data_sources/{id}/templates (paginated), backed up raw, written to <db>/Templates/, linked, counted', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	const { ds } = f.database(root.id, 'Tasks', { Name: { id: 'title', type: 'title', title: {} }, Status: { id: 'st', type: 'status', status: { options: [{ name: 'Todo', color: 'default' }] } } }, [['Row 1']]);
	const t1 = f.addTemplate(ds.id, 'Daily task', { Status: { id: 'st', type: 'status', status: { name: 'Todo', color: 'default' } } }, true);
	f.block(t1.id, 'to_do', { rich_text: rt('Template step'), checked: false });
	for (let i = 0; i < 101; i++) f.addTemplate(ds.id, 'T' + i);   // > 100 → second page of templates
	const v = new MemVault();
	const r = await runBackup(v, f.transport, okFetcher(), { target: 'N', roots: [], rowBodies: true, comments: 'none', downloadExternal: false, coloredPills: true, staticHeader: false, timeZone: 'Asia/Shanghai', minInterval: 0, sleep: noSleep });
	// read-only: only GETs on the templates endpoint, with start_cursor for page 2
	const tcalls = f.calls.filter(c => c.includes('/templates'));
	assert.ok(tcalls.length === 2 && tcalls.every(c => c.startsWith('GET ')), tcalls.join());
	assert.ok(f.calls.every(c => c.startsWith('GET ') || /^POST \/(search|data_sources\/[^/]+\/query)$/.test(c)));
	// raw layer keeps the template list; template page has its own raw JSON
	const raw = JSON.parse(await v.read([...v.files.keys()].find(k => k.startsWith('N/_raw/databases/'))!) as string);
	assert.equal(raw.data_sources[0].templates.length, 102);
	assert.ok(await v.read(`N/_raw/pages/${t1.id.replace(/-/g, '')}.json`));
	// note in the Templates sub-folder (not a row of the base: base filter is the database folder itself)
	const note = await v.read('N/Root/Tasks/Templates/Daily task.md');
	assert.ok(note, [...v.files.keys()].filter(k => k.includes('Templates')).slice(0, 3).join());
	const meta = fm(note!);
	assert.equal(meta['notion-template'], 'Daily task');
	assert.equal(meta['notion-template-default'], true);
	assert.equal(meta['notion-template-of'], '[[N/Root/Tasks/Tasks.base]]');
	assert.equal(meta.Status, 'Todo');
	assert.match(note!, /- \[ \] Template step/);
	assert.ok(![...v.files.keys()].some(k => k.includes('_Unsorted')), 'templates must not land in _Unsorted');
	// linked from the database: folded list under the embedded base + `notion: templates` in the .base
	const page = (await v.read('N/Root.md'))!;
	assert.match(page, /> \[!notion-templates\]- 📄 模板 \(102\)/);
	assert.match(page, /\[\[N\/Root\/Tasks\/Templates\/Daily task\|Daily task\]\] · 默认/);
	const base = YAML.parse((await v.read('N/Root/Tasks/Tasks.base'))!);
	assert.equal(base.notion.templates.length, 102);
	assert.deepEqual(base.notion.templates[0], { name: 'Daily task', file: 'N/Root/Tasks/Templates/Daily task.md', default: true });
	// verification line + report
	const line = r.lines.find(l => l.what.startsWith('数据库模板'))!;
	assert.ok(line.ok); assert.equal(line.notion, 102); assert.equal(line.vault, 102);
	assert.equal(r.snap.stats!.templatesReported, 102);
	// offline rebuild from raw gives the same template notes
	const r2 = await rebuildFromRaw(v, okFetcher(), { target: 'N', roots: [], rowBodies: true, comments: 'none', downloadExternal: false, coloredPills: true, staticHeader: false, timeZone: 'Asia/Shanghai' });
	assert.ok(r2.lines.find(l => l.what.startsWith('数据库模板'))!.ok);
	assert.equal(r2.plan!.writes.filter(w => w.path.includes('/Templates/')).length, 0, 'idempotent');
});

test('#21 templates endpoint failing is reported (backup incomplete), never silent', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	const { ds } = f.database(root.id, 'Tasks', { Name: { id: 'title', type: 'title', title: {} } }, [['Row 1']]);
	f.addTemplate(ds.id, 'A');
	f.failOnce.set(`/data_sources/${ds.id}/templates`, 403);
	const snap = await crawl(f);
	assert.equal(snap.complete, false);
	assert.ok(snap.errors!.some(e => e.includes('templates of data source') && e.includes('403')));
});

test('#22 optional Notion Markdown copy: one read-only GET per page into _raw/markdown, counted; skipped for unchanged pages on re-sync', async () => {
	const f = new FakeNotion();
	const root = f.page('Root', { type: 'workspace', workspace: true });
	f.childPage(root.id, 'Child');
	f.database(root.id, 'DB', { Name: { id: 'title', type: 'title', title: {} } }, [['R1'], ['R2']]);
	const v = new MemVault();
	const s = { target: 'N', roots: [], rowBodies: true, comments: 'none' as const, downloadExternal: false, coloredPills: true, staticHeader: false, timeZone: 'Asia/Shanghai', minInterval: 0, sleep: noSleep, markdownCopy: true };
	const r = await runBackup(v, f.transport, okFetcher(), s);
	const md = f.calls.filter(c => c.includes('/markdown'));
	assert.equal(md.length, 4);
	assert.ok(md.every(c => c.startsWith('GET ') && c.includes('markdown_version=v2')));
	assert.equal([...v.files.keys()].filter(k => k.startsWith('N/_raw/markdown/')).length, 4);
	const line = r.lines.find(l => l.what.startsWith('Notion 原生 Markdown'))!;
	assert.ok(line.ok); assert.equal(line.vault, 4);
	f.calls.length = 0;
	await runBackup(v, f.transport, okFetcher(), s);
	assert.equal(f.calls.filter(c => c.includes('/markdown')).length, 0, 'unchanged pages are not fetched again');
	// off by setting → no requests
	const v2 = new MemVault(); f.calls.length = 0;
	await runBackup(v2, f.transport, okFetcher(), { ...s, markdownCopy: false });
	assert.equal(f.calls.filter(c => c.includes('/markdown')).length, 0);
});
