// Calendar view editing (local only): drag an item to another day, drag the end of a range, new row on a day.
// Pure date arithmetic on the importer's date format ("2026-11-07", "2026-11-07T10:00", "…T10:00+08:00";
// a range is "<key>" + "<key> (end)"), unit-tested.

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const pad = (n: number) => String(n).padStart(2, '0');
export const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** whole days from a to b (YYYY-MM-DD), calendar arithmetic without time zones */
export function daysBetween(a: string, b: string): number {
	const pa = DAY.exec(a), pb = DAY.exec(b);
	if (!pa || !pb) return 0;
	return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
}

/** shift the day part of a date value by n days, keeping its time / offset text exactly */
export function shiftDay(value: string, n: number): string {
	const m = DAY.exec(value);
	if (!m) return value;
	const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` + value.slice(10);
}

/** a frontmatter date (string, Date or number from YAML) as the importer's string */
export function dateString(v: unknown): string | null {
	if (v === null || v === undefined || v === '') return null;
	if (v instanceof Date) return isNaN(+v) ? null : v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 16 : 10);
	const s = String(v).trim();
	return DAY.test(s) ? s : null;
}

/** Move an item so that it starts on `day`; a range keeps its length. */
export function moveToDay(start: string, end: string | null, day: string): { start: string; end: string | null } {
	const n = daysBetween(start.slice(0, 10), day);
	return { start: shiftDay(start, n), end: end ? shiftDay(end, n) : null };
}

/** Drag the end edge of an item to `day` (a single date becomes a range; never before the start). */
export function resizeEnd(start: string, end: string | null, day: string): { start: string; end: string | null } {
	const base = end ?? start;
	const n = Math.max(daysBetween(base.slice(0, 10), day), -daysBetween(start.slice(0, 10), base.slice(0, 10)));
	const ne = shiftDay(base, n);
	return { start, end: ne.slice(0, 10) === start.slice(0, 10) && !end ? null : ne };
}

// ---------------------------------------------------------------- round 8.1: drop rows from other views
/** Dropping a row on `day`: a row without a date gets a single-day date; a dated row moves like a calendar item
 *  (time / offset text kept, a range keeps its length). */
export function dropOnDay(start: string | null, end: string | null, day: string): { start: string; end: string | null } {
	if (!start) return { start: day, end: null };
	return moveToDay(start, end, day);
}

/** Does the dragged note belong to this calendar's database? (one of the rows Bases gave the view, or a note
 *  in the database's row folder — the base's `file.folder` filter). Rows of other databases are refused. */
export function sameDatabase(path: string, db: { rowPaths: Set<string>; folder: string | null }): boolean {
	if (!path.endsWith('.md')) return false;
	if (db.rowPaths.has(path)) return true;
	const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	return db.folder !== null && parent === db.folder;
}

/** What a drop wrote, so it can be undone: previous values (undefined = the key did not exist) and new values. */
export interface DateEdit { path: string; key: string; endKey: string; before: { start: unknown; end: unknown }; after: { start: string; end: string | null }; at: number }

/** Apply a drop to a frontmatter object (inside ONE processFrontMatter call). */
export function applyDateEdit(fm: Record<string, unknown>, e: Pick<DateEdit, 'key' | 'endKey' | 'after'>) {
	fm[e.key] = e.after.start;
	if (e.after.end) fm[e.endKey] = e.after.end; else delete fm[e.endKey];
}

/** Undo a drop on a frontmatter object. Returns false (and changes nothing) when the value was changed again since. */
export function undoDateEdit(fm: Record<string, unknown>, e: DateEdit): boolean {
	const cur = dateString(fm[e.key]), curEnd = dateString(fm[e.endKey]);
	if (cur !== e.after.start || (curEnd ?? null) !== (e.after.end ?? null)) return false;
	if (e.before.start === undefined) delete fm[e.key]; else fm[e.key] = e.before.start;
	if (e.before.end === undefined) delete fm[e.endKey]; else fm[e.endKey] = e.before.end;
	return true;
}

/** rows without a value in the date property (the 「无日期」 list) */
export function undatedRows<T extends { props: Record<string, unknown> }>(rows: T[], key: string): T[] {
	return rows.filter(r => !dateString(r.props[key]));
}
