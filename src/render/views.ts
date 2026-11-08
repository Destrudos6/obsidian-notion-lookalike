/* eslint-disable @typescript-eslint/no-explicit-any */
// Renderers for Notion view types that Obsidian Bases has no equivalent for: chart and calendar.
import { matches, type Row } from './filter.ts';
import { h, type HNode } from './hnode.ts';

export const NOTION_HEX: Record<string, string> = {
	default: '#9b9a97', gray: '#9b9a97', brown: '#a27763', orange: '#d9730d', yellow: '#dfab01',
	green: '#4d9b73', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47',
};
const PALETTE = ['#337ea9', '#4d9b73', '#dfab01', '#d9730d', '#9065b0', '#c14c8a', '#d44c47', '#a27763', '#9b9a97'];

export interface ChartSpec { source: string; title?: string; chart?: string; x: string; xType?: string; dateGroup?: string; aggregate?: string; sort?: string; colors?: Record<string, string>; filter?: string }
export interface CalendarSpec { source: string; title?: string; date: string; range?: string; filter?: string }

/** Parse the tiny YAML subset our converter writes into code blocks (flat keys + one level of nested map). */
export function parseSpec(src: string): any {
	const out: any = {}; let cur: any = null;
	for (const line of src.split('\n')) {
		if (!line.trim()) continue;
		const nested = line.match(/^ {2}("?)(.+?)\1: (.*)$/);
		if (nested && cur) { cur[nested[2]] = unq(nested[3]); continue; }
		const m = line.match(/^("?)(.+?)\1:\s*(.*)$/);
		if (!m) continue;
		if (m[3] === '') { cur = out[m[2]] = {}; } else { out[m[2]] = unq(m[3]); cur = null; }
	}
	return out;
}
function unq(s: string): any {
	s = s.trim();
	if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s; } }
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	if (s === 'true' || s === 'false') return s === 'true';
	return s;
}

function groupKey(v: any, spec: ChartSpec): string[] {
	if (v === null || v === undefined || v === '') return ['(空)'];
	if (Array.isArray(v)) return v.length ? v.map(String) : ['(空)'];
	if (spec.xType === 'date' || /^\d{4}-\d{2}-\d{2}/.test(String(v))) {
		const s = String(v);
		if (spec.dateGroup === 'year') return [s.slice(0, 4)];
		if (spec.dateGroup === 'month') return [s.slice(0, 7)];
		if (spec.dateGroup === 'week' || spec.dateGroup === 'day') return [s.slice(0, 10)];
		return [s.slice(0, 7)];
	}
	return [String(v)];
}

export function renderChart(spec: ChartSpec, rows: Row[]): HNode {
	const filter = spec.filter ? JSON.parse(spec.filter) : null;
	const counts = new Map<string, number>();
	for (const r of rows) {
		if (!matches(filter, r)) continue;
		for (const k of groupKey(r.props[spec.x], spec)) counts.set(k, (counts.get(k) || 0) + 1);
	}
	let entries = [...counts.entries()];
	const colorKeys = spec.colors ? Object.keys(spec.colors) : [];
	if (spec.sort === 'manual' && colorKeys.length) entries.sort((a, b) => (colorKeys.indexOf(a[0]) + 999 * +(colorKeys.indexOf(a[0]) < 0)) - (colorKeys.indexOf(b[0]) + 999 * +(colorKeys.indexOf(b[0]) < 0)));
	else if (spec.sort === 'descending') entries.sort((a, b) => b[0].localeCompare(a[0]));
	else entries.sort((a, b) => a[0].localeCompare(b[0]));
	const color = (k: string, i: number) => NOTION_HEX[spec.colors?.[k] || ''] || PALETTE[i % PALETTE.length];
	const total = entries.reduce((s, [, n]) => s + n, 0);
	const title = h('div', { class: 'n-chart-title' }, spec.title || '');

	if (!total) return h('div', { class: 'n-chart' }, title, h('div', { class: 'n-chart-empty' }, '无数据'));

	if (spec.chart === 'donut' || spec.chart === 'pie') {
		const R = 70, r = spec.chart === 'donut' ? 44 : 0, cx = 90, cy = 90;
		let a0 = -Math.PI / 2;
		const arcs: HNode[] = entries.map(([k, n], i) => {
			const a1 = a0 + (n / total) * Math.PI * 2;
			const large = a1 - a0 > Math.PI ? 1 : 0;
			const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
			const d = entries.length === 1
				? `M ${p(R, 0)} A ${R} ${R} 0 1 1 ${p(R, Math.PI)} A ${R} ${R} 0 1 1 ${p(R, 0)} M ${p(r, 0)} A ${r} ${r} 0 1 0 ${p(r, Math.PI)} A ${r} ${r} 0 1 0 ${p(r, 0)}`
				: `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
			a0 = a1;
			return h('path', { d, fill: color(k, i), 'fill-rule': 'evenodd' });
		});
		const legend = h('div', { class: 'n-chart-legend' }, ...entries.map(([k, n], i) =>
			h('div', { class: 'n-chart-legend-item' }, h('span', { class: 'n-chart-dot', style: `background:${color(k, i)}` }), `${k}  ${n}`)));
		return h('div', { class: 'n-chart n-chart-donut' }, title,
			h('div', { class: 'n-chart-body' },
				h('svg', { viewBox: '0 0 180 180', width: 180, height: 180 }, ...arcs,
					h('text', { x: 90, y: 96, 'text-anchor': 'middle', class: 'n-chart-total' }, String(total))),
				legend));
	}
	// column / bar
	const W = 520, H = 200, pad = 28;
	const max = Math.max(...entries.map(([, n]) => n));
	const bw = Math.min(48, (W - pad * 2) / entries.length * 0.6);
	const step = (W - pad * 2) / entries.length;
	const bars: HNode[] = [];
	entries.forEach(([k, n], i) => {
		const bh = (n / max) * (H - 50);
		const x = pad + step * i + (step - bw) / 2;
		bars.push(h('rect', { x, y: H - 24 - bh, width: bw, height: bh, rx: 3, fill: color(k, i) }));
		bars.push(h('text', { x: x + bw / 2, y: H - 28 - bh, 'text-anchor': 'middle', class: 'n-chart-val' }, String(n)));
		bars.push(h('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'n-chart-lbl' }, k.length > 8 ? k.slice(0, 7) + '…' : k));
	});
	return h('div', { class: 'n-chart n-chart-column' }, title,
		h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H },
			h('line', { x1: pad, y1: H - 24, x2: W - pad, y2: H - 24, class: 'n-chart-axis' }), ...bars));
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function renderCalendar(spec: CalendarSpec, rows: Row[], now = new Date(), openLink?: (path: string) => HNode['attrs'], o: { nav?: boolean; today?: Date; edit?: boolean } = {}): HNode {
	const filter = spec.filter ? JSON.parse(spec.filter) : null;
	const byDay = new Map<string, Row[]>();
	for (const r of rows) {
		if (!matches(filter, r)) continue;
		const v = r.props[spec.date];
		if (!v) continue;
		const start = String(v).slice(0, 10);
		const endV = r.props[`${spec.date} (end)`];
		const end = endV ? String(endV).slice(0, 10) : start;
		for (let d = new Date(start + 'T00:00'); ymd(d) <= end; d.setDate(d.getDate() + 1)) {
			const k = ymd(d); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k)!.push(r);
			if (byDay.size > 2000) break;
		}
	}
	const days: Date[] = [];
	const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (spec.range === 'week') {
		const s = new Date(first); s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
		for (let i = 0; i < 7; i++) { const d = new Date(s); d.setDate(s.getDate() + i); days.push(d); }
	} else {
		const s = new Date(now.getFullYear(), now.getMonth(), 1); s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
		for (let i = 0; i < 42; i++) { const d = new Date(s); d.setDate(s.getDate() + i); days.push(d); }
	}
	const today = o.today ?? now;
	const todayK = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
	const head = ['一', '二', '三', '四', '五', '六', '日'].map(w => h('div', { class: 'n-cal-head' }, w));
	// Notion lays multi-day items out in lanes: the same item keeps the same row inside a week
	const span = new Map<Row, { s: string; e: string }>();
	for (const [, list] of byDay) for (const r of list) if (!span.has(r)) {
		const s0 = String(r.props[spec.date]).slice(0, 10);
		const e0 = r.props[`${spec.date} (end)`] ? String(r.props[`${spec.date} (end)`]).slice(0, 10) : s0;
		span.set(r, { s: s0, e: e0 < s0 ? s0 : e0 });
	}
	const laneOf = new Map<string, (Row | null)[]>();   // day → lane slots
	for (let w = 0; w < days.length; w += 7) {
		const wk = days.slice(w, w + 7).map(ymd);
		const items = [...new Set(wk.flatMap(k => byDay.get(k) || []))]
			.sort((a, b) => span.get(a)!.s.localeCompare(span.get(b)!.s) || span.get(b)!.e.localeCompare(span.get(a)!.e) || a.name.localeCompare(b.name));
		const lanes: (Row | null)[][] = wk.map(() => []);
		for (const r of items) {
			const idx = wk.map((k, i) => ((byDay.get(k) || []).includes(r) ? i : -1)).filter(i => i >= 0);
			let lane = 0;
			while (idx.some(i => lanes[i][lane])) lane++;
			for (const i of idx) { while (lanes[i].length <= lane) lanes[i].push(null); lanes[i][lane] = r; }
		}
		wk.forEach((k, i) => laneOf.set(k, lanes[i]));
	}
	const cells = days.map(d => {
		const k = ymd(d);
		const slots = laneOf.get(k) || [];
		const cap = o.edit ? (spec.range === 'week' ? 12 : 4) : 4;
		const items = slots.slice(0, cap).map(r => {
			if (!r) return h('div', { class: 'n-cal-gap' });
			const sp = span.get(r)!;
			const cls = 'n-cal-item internal-link' + (sp.s < k ? ' is-cont' : '') + (sp.e > k ? ' is-more' : '');
			const a = h('a', { class: cls, 'data-href': r.path, href: r.path, 'data-path': r.path, ...(o.edit ? { draggable: 'true' } : {}), ...(openLink ? openLink(r.path) : {}) }, sp.s < k && d.getDay() !== 1 ? '\u00a0' : r.name);
			// the last day of an item gets the edge handle (drag = change the end date, like Notion)
			if (o.edit && sp.e === k) a.children!.push(h('span', { class: 'n-cal-resize', draggable: 'true', 'aria-label': '拖动修改结束日期', 'data-path': r.path }));
			return a;
		});
		const more = slots.slice(cap).filter(Boolean).length;
		return h('div', { class: 'n-cal-cell' + (k === todayK ? ' is-today' : '') + (d.getMonth() !== now.getMonth() && spec.range !== 'week' ? ' is-other' : ''), 'data-date': k },
			h('div', { class: 'n-cal-day' }, String(d.getDate()), o.edit ? h('span', { class: 'n-cal-add', 'aria-label': '在这一天新建' }, '＋') : null), ...items, more > 0 ? h('div', { class: 'n-cal-more' }, `+${more}`) : null);
	});
	const nav = o.nav ? h('div', { class: 'n-cal-nav' },
		o.edit ? h('div', { class: 'n-cal-range' },
			h('button', { class: 'n-cal-month' + (spec.range !== 'week' ? ' is-active' : '') }, '月'),
			h('button', { class: 'n-cal-week' + (spec.range === 'week' ? ' is-active' : '') }, '周')) : null,
		h('button', { class: 'n-cal-prev clickable-icon', 'aria-label': spec.range === 'week' ? '上一周' : '上个月' }, '‹'),
		h('button', { class: 'n-cal-today' }, '今天'),
		h('button', { class: 'n-cal-next clickable-icon', 'aria-label': spec.range === 'week' ? '下一周' : '下个月' }, '›')) : null;
	return h('div', { class: 'n-calendar' + (spec.range === 'week' ? ' is-week' : '') },
		h('div', { class: 'n-cal-top' }, h('div', { class: 'n-cal-title' }, `${spec.title ? spec.title + ' · ' : ''}${now.getFullYear()}年${now.getMonth() + 1}月`), nav),
		h('div', { class: 'n-cal-grid' }, ...head, ...cells));
}

/** Notion-style page header: cover banner + icon. */
export function renderHeader(cover: string | null, icon: string | null, iconImg: string | null): HNode {
	return h('div', { class: 'notion-header' + (cover ? ' has-cover' : '') + (icon || iconImg ? ' has-icon' : '') },
		cover ? h('div', { class: 'notion-cover', style: `background-image:url("${cover.replace(/"/g, '%22')}")` }) : null,
		iconImg ? h('div', { class: 'notion-icon' }, h('img', { src: iconImg })) : icon ? h('div', { class: 'notion-icon' }, icon) : null);
}
