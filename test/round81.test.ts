/* eslint-disable @typescript-eslint/no-explicit-any */
// Round 8.1: rows dragged from table / board / gallery / 无日期 onto the calendar; one naming rule for new rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDateEdit, dropOnDay, sameDatabase, undatedRows, undoDateEdit, type DateEdit } from '../src/render/calendar-edit.ts';
import { UNTITLED, isDefaultNewName, uniqueName } from '../src/core/naming.ts';
import { uniquePath, createPage } from '../src/notion/pages.ts';
import { fakeApp } from './stubs/obsidian.ts';

test('R81-1 same database only: rows of this view or of its row folder; other databases refused', () => {
	const db = { rowPaths: new Set(['DB/Tasks/A.md']), folder: 'DB/Tasks' };
	assert.equal(sameDatabase('DB/Tasks/A.md', db), true);
	assert.equal(sameDatabase('DB/Tasks/无日期任务.md', db), true, 'row not shown by the view (filtered) but same database folder');
	assert.equal(sameDatabase('DB/Projects/P.md', db), false, 'other database');
	assert.equal(sameDatabase('DB/Tasks/Sub/X.md', db), false, 'sub-page of a row is not a row');
	assert.equal(sameDatabase('DB/Tasks/Tasks.base', db), false);
	assert.equal(sameDatabase('Notes/A.md', { rowPaths: new Set(), folder: null }), false);
});

test('R81-2 no date → single-day date; dated row moves keeping time and duration', () => {
	assert.deepEqual(dropOnDay(null, null, '2026-11-12'), { start: '2026-11-12', end: null });
	assert.deepEqual(dropOnDay(null, '2026-11-01', '2026-11-12'), { start: '2026-11-12', end: null }, 'stray end without start is dropped');
	assert.deepEqual(dropOnDay('2026-11-03T09:30', null, '2026-11-12'), { start: '2026-11-12T09:30', end: null });
	assert.deepEqual(dropOnDay('2026-11-03T09:30+08:00', '2026-11-05T18:00+08:00', '2026-11-12'), { start: '2026-11-12T09:30+08:00', end: '2026-11-14T18:00+08:00' });
	assert.deepEqual(dropOnDay('2026-11-30', '2026-12-02', '2026-12-31'), { start: '2026-12-31', end: '2027-01-02' }, 'across month/year');
});

test('R81-3 one edit object per drop; undo restores the previous value (incl. "no date") only if unchanged since', () => {
	const fm: Record<string, unknown> = { title: 'x', 'Date (end)': '2026-01-01' };
	const e: DateEdit = { path: 'a.md', key: 'Date', endKey: 'Date (end)', before: { start: undefined, end: '2026-01-01' }, after: dropOnDay(null, null, '2026-11-12'), at: 0 };
	applyDateEdit(fm, e);
	assert.deepEqual(fm, { title: 'x', Date: '2026-11-12' });
	assert.equal(undoDateEdit(fm, e), true);
	assert.deepEqual(fm, { title: 'x', 'Date (end)': '2026-01-01' }, 'back to no Date key at all');
	// dated range
	const fm2: Record<string, unknown> = { Date: '2026-11-03T09:30', 'Date (end)': '2026-11-05T18:00' };
	const e2: DateEdit = { path: 'b.md', key: 'Date', endKey: 'Date (end)', before: { start: fm2.Date, end: fm2['Date (end)'] }, after: dropOnDay('2026-11-03T09:30', '2026-11-05T18:00', '2026-11-20'), at: 0 };
	applyDateEdit(fm2, e2);
	assert.deepEqual(fm2, { Date: '2026-11-20T09:30', 'Date (end)': '2026-11-22T18:00' });
	fm2.Date = '2026-11-25T09:30';   // changed again elsewhere → undo refuses, nothing touched
	assert.equal(undoDateEdit(fm2, e2), false);
	assert.equal(fm2.Date, '2026-11-25T09:30');
	fm2.Date = '2026-11-20T09:30';
	assert.equal(undoDateEdit(fm2, e2), true);
	assert.deepEqual(fm2, { Date: '2026-11-03T09:30', 'Date (end)': '2026-11-05T18:00' });
});

test('R81-4 「无日期」 list = rows with an empty / missing / invalid date', () => {
	const rows = [{ name: 'a', props: { Date: '2026-11-01' } }, { name: 'b', props: {} }, { name: 'c', props: { Date: '' } }, { name: 'd', props: { Date: null } }, { name: 'e', props: { Date: 'soon' } }];
	assert.deepEqual(undatedRows(rows, 'Date').map(r => r.name), ['b', 'c', 'd', 'e']);
});

test('R81-5 naming: 无标题, then 无标题 2, 3 …; Obsidian defaults recognised', () => {
	assert.equal(UNTITLED, '无标题');
	assert.equal(uniqueName('无标题', () => false), '无标题');
	const taken = new Set(['无标题', '无标题 2']);
	assert.equal(uniqueName('无标题', n => taken.has(n)), '无标题 3');
	const app: any = fakeApp(['DB/Tasks/无标题.md', 'DB/Tasks/Tasks.base', 'Top/无标题 2.md', 'Top/无标题.md', 'Top/无标题 3/']);
	assert.equal(uniquePath(app, 'DB/Tasks', UNTITLED, 'md'), 'DB/Tasks/无标题 2.md');
	assert.equal(uniquePath(app, 'Empty', UNTITLED, 'md'), 'Empty/无标题.md');
	assert.equal(uniquePath(app, 'Top', UNTITLED, 'md'), 'Top/无标题 4.md', 'a folder of the same name also counts (sub-page folder)');
	for (const n of ['Untitled', 'Untitled 2', '未命名', '未命名 3', '未命名文件']) assert.equal(isDefaultNewName(n), true, n);
	for (const n of ['无标题', '无标题 2', 'Untitled project', '我的未命名']) assert.equal(isDefaultNewName(n), false, n);
});

test('R81-6 page tree / ＋ new page uses the same helper (无标题 → 无标题 2)', async () => {
	const app: any = fakeApp(['P/无标题.md', 'P/']);
	const created: string[] = [];
	app.vault.create = async (p: string) => { created.push(p); return { path: p }; };
	await createPage(app, {} as any, null, 'P');
	assert.deepEqual(created, ['P/无标题 2.md']);
});

test('R81-7 no 「未命名」 / "Untitled" literal is used for new files anywhere in src (single helper)', async () => {
	const { readFileSync, readdirSync, statSync } = await import('node:fs');
	const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? (n === 'generated' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : []; });
	const bad: string[] = [];
	for (const f of walk('src')) {
		const t = readFileSync(f, 'utf8');
		if (/未命名/.test(t) && !f.endsWith('core/naming.ts')) bad.push(f + ': 未命名');
		if (/['"`]无标题/.test(t) && !f.endsWith('core/naming.ts')) bad.push(f + ': literal 无标题');
	}
	assert.deepEqual(bad, []);
});
