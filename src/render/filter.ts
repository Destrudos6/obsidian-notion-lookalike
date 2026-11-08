/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SimpleFilter } from '../core/views.ts';

export interface Row { name: string; path: string; props: Record<string, any> }

const linkPath = (v: unknown): string => {
	const m = String(v ?? '').match(/\[\[([^|\]]+)/);
	return m ? m[1] : String(v ?? '');
};

function today(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
const asDate = (v: unknown): Date | null => { if (!v) return null; const d = new Date(String(v)); return isNaN(+d) ? null : d; };
const DAY = 86400000;

export function matches(f: SimpleFilter | null | undefined, row: Row): boolean {
	if (!f) return true;
	if ('and' in f) return f.and.every(x => matches(x, row));
	if ('or' in f) return f.or.some(x => matches(x, row));
	const raw = f.prop === 'file.name' ? row.name : row.props[f.prop];
	const empty = raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
	switch (f.cond) {
		case 'empty': return empty;
		case 'not_empty': return !empty;
		case 'eq': return f.value === true ? raw === true : String(raw ?? '') === String(f.value);
		case 'neq': return f.value === true ? raw !== true : String(raw ?? '') !== String(f.value);
		case 'contains': return Array.isArray(raw) ? raw.map(String).includes(String(f.value)) : String(raw ?? '').includes(String(f.value));
		case 'not_contains': return !(Array.isArray(raw) ? raw.map(String).includes(String(f.value)) : String(raw ?? '').includes(String(f.value)));
		case 'link_contains': return (Array.isArray(raw) ? raw : [raw]).some(x => linkPath(x) === f.value);
		case 'gt': case 'gte': case 'lt': case 'lte': {
			let a: number, b: number;
			if (typeof f.value === 'number') { a = Number(raw); b = f.value; }
			else {
				const d = asDate(raw); if (!d) return false; a = +d;
				b = f.value === 'today' ? +today() : +(asDate(f.value) || today());
			}
			if (isNaN(a)) return false;
			return f.cond === 'gt' ? a > b : f.cond === 'gte' ? a >= b : f.cond === 'lt' ? a < b : a <= b;
		}
		case 'date_past_week': { const d = asDate(raw); return !!d && +d >= +today() - 7 * DAY && +d <= +today(); }
		case 'date_next_week': { const d = asDate(raw); return !!d && +d >= +today() && +d <= +today() + 7 * DAY; }
		case 'date_this_week': { const d = asDate(raw); return !!d && Math.abs(+d - +today()) <= 6 * DAY; }
		default: return true;
	}
}
