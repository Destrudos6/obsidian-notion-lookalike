/* eslint-disable @typescript-eslint/no-explicit-any */
// Round 8: Chinese input triggers, sync conflicts, private-API self-check, quick (incremental) re-sync, block moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slashTrigger, mentionTrigger, inBlockCode } from '../src/notion/trigger.ts';
import { matchItems } from '../src/notion/slash.ts';
import { planSync, contentHash, chooseSyncMode, type Manifest } from '../src/core/backup.ts';
import { runBackup } from '../src/pipeline.ts';
import { probe, Compat, FEATURES } from '../src/compat.ts';
import { parseBlocks, moveBlockStep, ensureBlockId, siblingOf } from '../src/notion/block-model.ts';
import { FakeNotion, MemVault, okFetcher, rt } from './fake-notion.ts';

const noSleep = async () => {};
const settings = { target: 'Notion', roots: [], rowBodies: true, comments: 'none' as const, downloadExternal: false, coloredPills: true, staticHeader: false, timeZone: 'Asia/Shanghai', minInterval: 0, sleep: noSleep, markdownCopy: false };

// ------------------------------------------------------------------ P1
test('R8-1 slash trigger: / 、 ／ anywhere incl. right after CJK; not after ASCII words, in code, URLs, links', () => {
	assert.deepEqual(slashTrigger('读书、'), { start: 2, query: '', char: '、' });
	assert.deepEqual(slashTrigger('读书/'), { start: 2, query: '', char: '/' });
	assert.deepEqual(slashTrigger('读书／标题'), { start: 2, query: '标题', char: '／' });
	assert.deepEqual(slashTrigger('、h1'), { start: 0, query: 'h1', char: '、' });
	assert.deepEqual(slashTrigger('- 、'), { start: 2, query: '', char: '、' });
	assert.equal(slashTrigger('and/or'), null, 'ASCII word before half-width / = not a menu');
	assert.equal(slashTrigger('1/2'), null);
	assert.equal(slashTrigger('看 https://a.com/'), null, 'URL');
	assert.equal(slashTrigger('看 www.a.com/'), null);
	assert.equal(slashTrigger('`读书、'), null, 'inline code');
	assert.equal(slashTrigger('[[读书、'), null, 'wiki link');
	assert.equal(slashTrigger('[x](读书/'), null, 'link target');
	assert.equal(slashTrigger('苹果、香蕉，'), null, 'punctuation ends the query');
	assert.equal(slashTrigger('苹果、 '), null, 'space ends it');
	assert.equal(slashTrigger('、、'), null);
	assert.ok(slashTrigger('`code` 读书、'), 'closed inline code before is fine');
	const doc = ['---', 'a: 、', '---', '```', 'x、', '```', '正文、'];
	assert.equal(inBlockCode(i => doc[i], 1), true);
	assert.equal(inBlockCode(i => doc[i], 4), true);
	assert.equal(inBlockCode(i => doc[i], 6), false);
});

test('R8-2 slash menu keeps a normal 、: a query with no match closes the menu (onTrigger returns null)', () => {
	assert.ok(matchItems('标题').length >= 3);
	assert.ok(matchItems('h2').some(i => i.name === '标题 2'));
	assert.equal(matchItems('香蕉').length, 0, '苹果、香蕉 → no item → no menu, text untouched');
	assert.ok(matchItems('').length > 20);
});

test('R8-3 mention trigger: @ / ＠ after CJK or at start, not in e-mail addresses, code or URLs', () => {
	assert.deepEqual(mentionTrigger('提醒＠今天'), { start: 2, query: '今天', char: '＠' });
	assert.deepEqual(mentionTrigger('提醒@'), { start: 2, query: '', char: '@' });
	assert.deepEqual(mentionTrigger('@Li'), { start: 0, query: 'Li', char: '@' });
	assert.equal(mentionTrigger('mail a@b'), null);
	assert.equal(mentionTrigger('`@x'), null);
	assert.equal(mentionTrigger('https://x.com/@me'), null);
});

// ------------------------------------------------------------------ P2
test('R8-4 sync plan: local-only edit is kept (no overwrite), both-changed = conflict (keep local + Notion copy), choice notion = backup then write', () => {
	const prev: Manifest = { version: 1, startedAt: '', complete: true, scope: [], assets: {}, files: { 'N/a.md': { hash: contentHash('A1') }, 'N/b.md': { hash: contentHash('B1') } }, ids: { a: 'N/a.md', b: 'N/b.md' } };
	const vault: Record<string, string> = { 'N/a.md': 'A1 + mine', 'N/b.md': 'B1 + mine' };
	const base = { target: 'N', prev, idPaths: { a: 'N/a.md', b: 'N/b.md' }, read: (p: string) => vault[p] ?? null, scope: [], stamp: 'T', complete: true };
	const p = planSync({ ...base, files: [{ path: 'N/a.md', content: 'A1' }, { path: 'N/b.md', content: 'B2' }] });
	assert.deepEqual(p.keptLocal, ['N/a.md']);
	assert.deepEqual(p.writes, []);
	assert.deepEqual(p.backups, []);
	assert.equal(p.conflicts.length, 1);
	assert.equal(p.conflicts[0].choice, 'local');
	assert.deepEqual(p.conflicts[0].localLines, { added: 1, removed: 1 });
	const q = planSync({ ...base, files: [{ path: 'N/a.md', content: 'A1' }, { path: 'N/b.md', content: 'B2' }], resolve: { 'N/b.md': 'notion' } });
	assert.deepEqual(q.backups, [{ from: 'N/b.md', to: 'N/_本地修改备份/T/b.md' }]);
	assert.deepEqual(q.writes.map(w => w.path), ['N/b.md']);
});

function world() {
	const f = new FakeNotion();
	f.edited = '2026-11-01T00:00:00.000Z';
	const root = f.page('Home', { type: 'workspace', workspace: true });
	f.block(root.id, 'paragraph', { rich_text: rt('hello') });
	const a = f.childPage(root.id, 'Alpha'); f.block(a.id, 'paragraph', { rich_text: rt('alpha body') });
	const b = f.childPage(root.id, 'Beta'); f.block(b.id, 'paragraph', { rich_text: rt('beta body') });
	const { db, ds } = f.database(root.id, 'Tasks', { Name: { id: 'title', type: 'title', title: {} }, Done: { id: 'd', type: 'checkbox', checkbox: {} } }, [['T1', {}], ['T2', {}]]);
	return { f, root, a, b, db, ds };
}

test('R8-5 pipeline: conflict modal gets title / Notion time / line counts; nothing lost either way; 变更记录 lists backups with links', async () => {
	const { f, a, b } = world();
	const v = new MemVault();
	await runBackup(v, f.transport, okFetcher(), settings);
	// local edits on Alpha (also changed in Notion) and Beta (Notion unchanged)
	v.files.set('Notion/Home/Alpha.md', String(v.files.get('Notion/Home/Alpha.md')) + '\nlocal alpha\n');
	v.files.set('Notion/Home/Beta.md', String(v.files.get('Notion/Home/Beta.md')) + '\nlocal beta\n');
	f.children[a.id][0].paragraph.rich_text = rt('alpha v2'); f.pages[a.id].last_edited_time = '2026-11-08T01:00:00.000Z';
	let asked: any[] = [];
	const r = await runBackup(v, f.transport, okFetcher(), { ...settings, resolveConflicts: async c => { asked = c; return { [c[0].path]: 'notion' }; } }, () => {}, () => false, () => new Date(2026, 10, 8, 12, 0, 0));
	assert.equal(asked.length, 1);
	assert.equal(asked[0].title, 'Alpha');
	assert.equal(asked[0].notionEdited, '2026-11-08T01:00:00.000Z');
	assert.match(String(v.files.get('Notion/Home/Alpha.md')), /alpha v2/);
	assert.match(String(v.files.get('Notion/_本地修改备份/2026-11-08 120000/Home/Alpha.md')), /local alpha/);
	assert.match(String(v.files.get('Notion/Home/Beta.md')), /local beta/, 'Notion unchanged → local edit kept');
	assert.deepEqual(r.plan!.keptLocal, ['Notion/Home/Beta.md']);
	const rep = String(v.files.get('Notion/_导入报告.md'));
	assert.match(rep, /## 变更记录/);
	assert.match(rep, /\[\[Notion\/Home\/Alpha\|Alpha\]\] \| 覆盖（本地修改过） \| \[\[Notion\/_本地修改备份\/2026-11-08 120000\/Home\/Alpha\|打开备份\]\]/);
	// next sync: nothing changed anywhere → Beta's local edit still kept, no new conflicts
	const r2 = await runBackup(v, f.transport, okFetcher(), { ...settings, resolveConflicts: async () => { throw new Error('should not ask'); } });
	assert.equal(r2.plan!.conflicts.length, 0);
	assert.match(String(v.files.get('Notion/Home/Beta.md')), /local beta/);
	void b;
});

// ------------------------------------------------------------------ P3
test('R8-6 private API self-check: stubs without internals → ⚠ per feature, no throw; full stub → ✓', () => {
	const none = probe({}, {});
	for (const id of ['hotkeys', 'linkConfig', 'settings', 'commands', 'bookmarks', 'leftSplit', 'theme', 'embed']) assert.equal(none[id], 'missing', id);
	assert.equal(none.submenu, 'unknown');
	const throwing = probe({ get hotkeyManager() { throw new Error('x'); } }, {});
	assert.equal(throwing.hotkeys, 'missing');
	const f = () => {};
	const full = probe({ hotkeyManager: { getDefaultHotkeys: f, addDefaultHotkeys: f, removeDefaultHotkeys: f }, vault: { getConfig: f, setConfig: f }, setting: { open: f, openTabById: f }, commands: { executeCommandById: f },
		internalPlugins: { getPluginById: () => ({}) }, workspace: { leftSplit: { expand: f }, iterateAllLeaves: (cb: any) => cb({ view: { getViewType: () => 'markdown' }, tabHeaderInnerTitleEl: {} }) }, changeTheme: f, embedRegistry: { embedByExtension: { base: f } } },
		{ plugin: { registerBasesView: f }, MenuItem: class { setSubmenu() {} } });
	for (const id of ['hotkeys', 'linkConfig', 'settings', 'commands', 'bookmarks', 'leftSplit', 'theme', 'embed', 'submenu', 'tabTitle', 'basesView']) assert.equal(full[id], 'ok', id);
	const c = new Compat(none);
	c.mark('boardItems', false);
	assert.equal(c.ok('boardItems'), false);
	assert.equal(c.ok('basesFormulas'), true, 'unknown counts as usable (feature still guards itself)');
	assert.equal(c.rows().length, FEATURES.length);
	assert.ok(c.rows().every(r => r.fallback && r.feature));
});

// ------------------------------------------------------------------ P4
test('R8-7 quick re-sync: no change → no database / view / data-source reads, same notes; first run and every 5th run full', async () => {
	const { f } = world();
	const v = new MemVault();
	const r1 = await runBackup(v, f.transport, okFetcher(), settings);
	assert.ok(r1.complete);
	const before = new Map([...v.files].filter(([k]) => /\.(md|base)$/.test(k) && !k.includes('_导入报告')));
	const m1 = JSON.parse(String(v.files.get('Notion/_raw/manifest.json')));
	assert.equal(m1.mode, 'full');
	f.calls = [];
	const r2 = await runBackup(v, f.transport, okFetcher(), settings);
	assert.ok(r2.complete, r2.snap.errors!.join('\n'));
	const m2 = JSON.parse(String(v.files.get('Notion/_raw/manifest.json')));
	assert.equal(m2.mode, 'quick');
	assert.equal(r2.snap.stats!.reusedDatabases, 1);
	assert.ok(!f.calls.some(c => /^GET \/(databases|views|data_sources)\//.test(c)), f.calls.join('\n'));
	assert.ok(!f.calls.some(c => /^GET \/pages\//.test(c)), 'pages come from search');
	assert.ok(!f.calls.some(c => /^GET \/blocks\//.test(c)), 'trusted unchanged pages: no block reads');
	for (const [k, val] of before) assert.equal(v.files.get(k), val, k);
	assert.equal(r2.plan!.writes.length, 0);
	assert.equal(chooseSyncMode({ ...m2, quickRuns: 4 }, {}, new Date()), 'full');
	assert.equal(chooseSyncMode(m2, { full: true }, new Date()), 'full');
	assert.equal(chooseSyncMode({ ...m2, lastFull: '2026-01-01T00:00:00Z' }, {}, new Date('2026-11-08')), 'full');
});

test('R8-8 quick re-sync never misses: edited row, new row not yet in search, deleted row, edited page, schema change', async () => {
	const { f, a, ds } = world();
	const v = new MemVault();
	await runBackup(v, f.transport, okFetcher(), settings);
	const now = () => new Date(Date.now() + 1000).toISOString();
	// 1) edited row
	const row = f.rows[ds.id][0];
	row.properties.Done = { id: 'd', type: 'checkbox', checkbox: true }; row.last_edited_time = now();
	let r = await runBackup(v, f.transport, okFetcher(), settings);
	assert.match(String(v.files.get('Notion/Home/Tasks/T1.md')), /Done: true/);
	// 2) new row that search has not indexed yet (hidden from search) → caught by the "edited since" query
	const nr = f.addRow(ds.id, 'T3', {}); nr.last_edited_time = now();
	const hidden = f.pages[nr.id]; delete f.pages[nr.id];
	f.children[nr.id] = [];
	r = await runBackup(v, f.transport, okFetcher(), settings);
	f.pages[nr.id] = hidden;
	assert.equal(JSON.parse(String(v.files.get('Notion/_raw/manifest.json'))).mode, 'quick');
	assert.ok(v.files.has('Notion/Home/Tasks/T3.md'), 'new row found');
	// 3) deleted row → archived, not lost
	f.rows[ds.id] = f.rows[ds.id].filter(x => x.id !== f.rows[ds.id][1].id);
	const gone = Object.values(f.pages).find((p: any) => p.properties.title.title[0]?.plain_text === 'T2') as any;
	gone.in_trash = true;
	r = await runBackup(v, f.transport, okFetcher(), settings);
	assert.ok(r.complete);
	assert.ok(v.files.has('Notion/_已在Notion删除/Home/Tasks/T2.md'));
	// 4) edited page
	f.children[a.id][0].paragraph.rich_text = rt('alpha v3'); f.pages[a.id].last_edited_time = now();
	await runBackup(v, f.transport, okFetcher(), settings);
	assert.match(String(v.files.get('Notion/Home/Alpha.md')), /alpha v3/);
	// 5) schema change (new property) → full read of that database
	f.dataSources[ds.id].properties.Note = { id: 'n', type: 'rich_text', rich_text: {} }; f.dataSources[ds.id].last_edited_time = now();
	f.calls = [];
	const m = JSON.parse(String(v.files.get('Notion/_raw/manifest.json'))); m.quickRuns = 0; v.files.set('Notion/_raw/manifest.json', JSON.stringify(m));
	r = await runBackup(v, f.transport, okFetcher(), { ...settings, fullVerify: false });
	assert.equal(JSON.parse(String(v.files.get('Notion/_raw/manifest.json'))).mode, 'quick');
	assert.ok(f.calls.some(c => c.startsWith(`GET /databases/`)), 'database re-read');
	assert.match(String(v.files.get('Notion/Home/Tasks/Tasks.base')), /Note/);
});

test('R8-9 quick mode: a page edited within 2 minutes of our copy is never trusted; synced-block pages always re-checked', async () => {
	const { f, a } = world();
	const v = new MemVault();
	await runBackup(v, f.transport, okFetcher(), settings);
	// raw fetchedAt ≈ now; last_edited = now (same minute, unchanged value) → must be re-checked, not trusted
	const raw = JSON.parse(String(v.files.get(`Notion/_raw/pages/${a.id.replace(/-/g, '')}.json`)));
	f.pages[a.id].last_edited_time = raw.page.last_edited_time = new Date(Date.parse(raw.fetchedAt) - 30000).toISOString();
	v.files.set(`Notion/_raw/pages/${a.id.replace(/-/g, '')}.json`, JSON.stringify(raw));
	f.children[a.id][0].paragraph.rich_text = rt('same-minute edit');
	f.children[a.id].push({ object: 'block', id: 'zz', type: 'paragraph', paragraph: { rich_text: rt('x') }, has_children: false });
	await runBackup(v, f.transport, okFetcher(), settings);
	assert.match(String(v.files.get('Notion/Home/Alpha.md')), /same-minute edit/);
});

// ------------------------------------------------------------------ P5/P6
test('R8-10 block move up/down swaps with the sibling (list item keeps its children); block id for 复制块链接', () => {
	const t = ['# T', '', 'one', '', '- a', '    - a1', '- b', '', 'two'].join('\n');
	const bs = parseBlocks(t.split('\n'));
	const b = bs.find(x => t.split('\n')[x.from] === '- b')!;
	const up = moveBlockStep(t, b, -1)!;
	assert.equal(up.text, ['# T', '', 'one', '', '- b', '- a', '    - a1', '', 'two'].join('\n'));
	assert.equal(up.text.split('\n')[up.line], '- b');
	const two = bs.find(x => t.split('\n')[x.from] === 'two')!;
	assert.equal(moveBlockStep(t, two, 1), null, 'last block cannot go down');
	assert.ok(siblingOf(bs, two, -1));
	const p = bs.find(x => t.split('\n')[x.from] === 'one')!;
	const r = ensureBlockId(t, p, 'abc123');
	assert.equal(r.text.split('\n')[2], 'one ^abc123');
	assert.equal(ensureBlockId(r.text, p, 'zzz').id, 'abc123', 'reuses an existing id');
	const q = '> [!note]\n> hi\nnext';
	const qb = parseBlocks(q.split('\n'))[0];
	assert.equal(ensureBlockId(q, qb, 'q1').text, '> [!note]\n> hi\n\n^q1\n\nnext');
});
