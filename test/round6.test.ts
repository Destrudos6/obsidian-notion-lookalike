/* eslint-disable @typescript-eslint/no-explicit-any */
// Round 6: emoji images, Notion-mode page tree model, "/" menu Markdown = importer Markdown, delivered sample vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const stub = await import('./stubs/obsidian.ts');
const { PageModel, isHiddenName } = await import('../src/notion/pages.ts');
const emoji = await import('../src/emoji.ts');

test('R6-1 emoji pack decodes offline; every emoji icon of the converted fixture workspace (and 🛟 / 🗄️) has an image', async () => {
	const pack = await emoji.loadEmoji();
	assert.ok(pack, 'pack decoded');
	assert.ok(Object.keys(pack!.svg).length >= 1900);
	assert.ok(emoji.emojiList().length >= 1850);
	assert.equal(emoji.emojiKey('🗄️'), '1f5c4');                 // VS16 dropped (no ZWJ)
	assert.equal(emoji.emojiKey('❤️‍🔥'), '2764-fe0f-200d-1f525'); // ZWJ keeps FE0F
	for (const e of ['🛟', '🗄️', '🗃️', '❤️‍🔥', '🇨🇳', '#️⃣']) assert.ok(emoji.emojiUrl(e), 'no image for ' + e);
	assert.ok(emoji.isEmoji('🛟') && emoji.isEmoji('🗄️') && emoji.isEmoji('👍🏽') && !emoji.isEmoji('ab') && !emoji.isEmoji('[[x.png]]'));
	// all icons the importer wrote: notes, databases, callouts
	const icons = new Set<string>();
	const walk = (d: string) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (n === '_raw' || n === '_attachments' || n === '.obsidian') continue; if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(md|base)$/.test(n)) {
		const t = fs.readFileSync(p, 'utf8');
		for (const m of t.matchAll(/^(?:notion-icon|  icon): (.+)$/gm)) icons.add(m[1].replace(/^"|"$/g, ''));
		for (const m of t.matchAll(/\[!notion-callout\|[^\]]*\] (\S+)/g)) icons.add(m[1]);
	} } };
	// (open-source repo) icons from the converted synthetic workspace instead of a delivered sample vault
	const { convertSnapshot } = await import('../src/core/convert.ts');
	const { loadSnapshot } = await import('../scripts/load-fixtures.ts');
	for (const f of convertSnapshot(loadSnapshot()).files) {
		for (const m of f.content.matchAll(/^(?:notion-icon|  icon|# notion-icon): (.+)$/gm)) icons.add(m[1].replace(/^"|"$/g, ''));
		for (const m of f.content.matchAll(/\[!notion-callout\|[^\]]*\] (\S+)/g)) icons.add(m[1]);
	}
	void walk;
	const em = [...icons].filter(i => emoji.isEmoji(i));
	assert.ok(em.length >= 20, 'found emoji icons: ' + em.length);
	const missing = em.filter(e => !emoji.emojiUrl(e));
	assert.deepEqual(missing, [], 'emoji icons without image');
	// the SVG is a complete document
	const u = decodeURIComponent(emoji.emojiUrl('🛟')!.split(',')[1]);
	assert.match(u, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 36 36">.*<\/svg>$/s);
});

test('R6-2 page tree: folder + same-name note = one page, databases are rows, bookkeeping hidden, import folder lifted', () => {
	const app = stub.fakeApp([
		'Notion/_raw/pages/x.json', 'Notion/_attachments/a.png', 'Notion/_导入报告.md', 'Notion/_本地修改备份/', 'Notion/_已在Notion删除/old.md',
		'Notion/Home Hub.md', 'Notion/Home Hub/Databases.md', 'Notion/Home Hub/Databases/Projects/Projects.base', 'Notion/Home Hub/Databases/Projects/Row.md',
		'Notion/Home Hub/Databases/Projects/Templates/New Project.md', 'Notion/Home Hub/Mobile.md', 'Notion/Home Hub/Reviews.md',
		'Notion/Databases/Timetable/Timetable.base', 'Notion/Databases/Timetable/Monday.md', 'Notion/Reading List.md', 'Notion/Reading List/图片/a.png',
		'My page.md', 'attachments/b.png', 'Inbox/note.md',
	], { 'Notion/Home Hub.md': ['Reviews', 'Mobile', 'Databases'] });
	const model = new PageModel(app as any, () => 'Notion');
	const top = model.children(null);
	const titles = top.map(n => `${n.kind}:${n.title}`).sort();
	assert.deepEqual(titles, ['folder:Databases', 'folder:Inbox', 'page:Reading List', 'page:Home Hub', 'page:My page'].sort());
	const home = top.find(n => n.title === 'Home Hub')!;
	assert.equal(home.folder?.path, 'Notion/Home Hub');                  // merged with its folder
	const kids = model.defaultOrder(home, model.children(home));
	assert.deepEqual(kids.map(k => k.title), ['Reviews', 'Mobile', 'Databases']);   // Notion order = link order in the parent page
	assert.equal(kids.filter(k => k.title === 'Databases').length, 1, 'Databases folder + Databases.md = one row');
	const dbs = model.children(kids.find(k => k.title === 'Databases')!);
	assert.deepEqual(dbs.map(d => `${d.kind}:${d.title}`), ['database:Projects']);
	assert.deepEqual(model.children(dbs[0]), [], 'rows / Templates are not listed under a database');
	const lib = top.find(n => n.title === 'Reading List')!;
	assert.deepEqual(model.children(lib), [], 'attachment-only folder hidden');
	const groups = model.children(top.find(n => n.title === 'Databases')!);
	assert.deepEqual(groups.map(g => `${g.kind}:${g.title}`), ['database:Timetable']);
	for (const n of ['_raw', '_attachments', '_导入报告.md', '_本地修改备份', '_已在Notion删除', '.obsidian']) assert.ok(isHiddenName(n), n);
	// breadcrumb chain of a database row
	const row = app.vault.getAbstractFileByPath('Notion/Home Hub/Databases/Projects/Row.md') as any;
	assert.deepEqual(model.ancestors(row).map(a => `${a.kind}:${a.title}`), ['page:Home Hub', 'page:Databases', 'database:Projects']);
	const base = app.vault.getAbstractFileByPath('Notion/Home Hub/Databases/Projects/Projects.base') as any;
	assert.deepEqual(model.ancestors(base).map(a => a.title), ['Home Hub', 'Databases']);
});

test('R6-3 "/" menu inserts exactly the importer\'s Markdown (toggle, toggle heading, callout, columns, toc)', async () => {
	const { MD, CUR } = await import('../src/notion/blocks-md.ts');
	const { renderBlocks } = await import('../src/core/blocks.ts');
	const { Ctx } = await import('../src/core/context.ts');
	const { DEFAULT_OPTIONS } = await import('../src/core/types.ts');
	const c = new Ctx({ ...DEFAULT_OPTIONS, timeZone: 'Asia/Shanghai' });
	const rt = (s: string) => [{ type: 'text', text: { content: s }, plain_text: s, annotations: {} }];
	let n = 0; const blk = (type: string, data: any, children?: any[]) => ({ id: 'b' + n++, type, [type]: data, has_children: !!children, children });
	const strip = (l: string[]) => l.join('\n').replace(CUR, 'X');
	const imp = (b: any) => renderBlocks([b], c).join('\n');
	assert.equal(strip(MD.toggle()).split('\n')[0], imp(blk('toggle', { rich_text: rt('X') }, [blk('paragraph', { rich_text: rt('y') })])).split('\n')[0]);
	assert.equal(strip(MD.toggle(2)).split('\n')[0], imp(blk('heading_2', { rich_text: rt('X'), is_toggleable: true }, [blk('paragraph', { rich_text: rt('y') })])).split('\n')[0]);
	assert.equal(strip(MD.callout('yellow-bg', '💡')), imp(blk('callout', { rich_text: rt('X'), icon: { type: 'emoji', emoji: '💡' }, color: 'yellow_background' })));
	const cols = imp(blk('column_list', {}, [blk('column', {}, [blk('paragraph', { rich_text: rt('X') })]), blk('column', {}, [blk('paragraph', { rich_text: rt('Y') })])]));
	assert.equal(strip(MD.columns(2)).replace('> > \n', '> > Y\n').replace(/> > $/, '> > Y'), cols);
	assert.equal(MD.toc().slice(0, 2).join('\n'), imp(blk('table_of_contents', {})));
});

const SAMPLE = path.join(ROOT, 'sample-vault');
test('R6-4 delivered sample vault: no demo/test notes, no plugin data.json, report reachable', { skip: !fs.existsSync(SAMPLE) && 'run `npm run sample` first' }, () => {
	const v = SAMPLE;
	for (const n of ['Backup fidelity demo.md', 'Icon link demo.md']) assert.ok(!fs.existsSync(path.join(v, n)), n + ' must not be in the vault');
	assert.ok(fs.existsSync(path.join(ROOT, 'test/demo-notes/Backup fidelity demo.md')), 'demo kept as test fixture');
	assert.ok(!fs.existsSync(path.join(v, '.obsidian/plugins/notion-lookalike-importer/data.json')));
	assert.ok(fs.existsSync(path.join(v, 'Notion/_导入报告.md')));
	assert.ok(fs.existsSync(path.join(v, 'Notion/_raw/manifest.json')), 'Notion mode turns itself on for imported vaults (manifest present)');
});
