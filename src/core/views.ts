/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion views (Views API, Notion-Version 2026-03-11) → Obsidian Bases views,
// plus a small structured filter ("SimpleFilter") that the plugin's own chart/calendar
// renderers and the offline preview can evaluate.
import type { Ctx } from './context.ts';
import { propKey } from './properties.ts';
import type { NotionObj } from './types.ts';
import { hash } from './util.ts';

export type SimpleCond = 'eq' | 'neq' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'gt' | 'gte' | 'lt' | 'lte' | 'link_contains' | 'date_past_week' | 'date_next_week' | 'date_this_week' | 'date_today';
export type SimpleFilter = { and: SimpleFilter[] } | { or: SimpleFilter[] } | { prop: string; cond: SimpleCond; value?: unknown };

export interface Schema {
	byId: Map<string, any>;      // property id → property schema (with .name)
	byName: Map<string, any>;
	titleName: string;
	ordered: any[];              // schema order
}

export function schemaOf(dataSource: NotionObj): Schema {
	const byId = new Map<string, any>(); const byName = new Map<string, any>();
	let titleName = 'Name';
	const ordered: any[] = [];
	for (const [name, p] of Object.entries<any>(dataSource?.properties || {})) {
		const q = { ...p, name };
		byId.set(p.id, q); byId.set(decodeURIComponent(p.id), q); byName.set(name, q); ordered.push(q);
		if (p.type === 'title') titleName = name;
	}
	return { byId, byName, titleName, ordered };
}

export function optionsOf(p: any): { name: string; color: string }[] {
	return p?.select?.options || p?.multi_select?.options || p?.status?.options || [];
}

const PILL_TYPES = new Set(['select', 'multi_select', 'status']);

/** Key used in `order`/`groupBy` for a schema property (title → file.name; select → colored pill formula). */
export function columnKey(p: any, pills: boolean): string {
	if (p.type === 'title') return 'file.name';
	if (p.liveKey) return `formula.${p.liveDisplay || p.liveKey}`;
	if (pills && PILL_TYPES.has(p.type) && optionsOf(p).length) return `formula.${pillFormulaName(p)}`;
	if (isPercent(p)) return `formula.${pctFormulaName(p)}`;
	return propKey(p.name);
}

export const isPercent = (p: any): boolean => p?.type === 'number' && p.number?.format === 'percent';
export function pctFormulaName(p: any): string { return 'pct_' + hash(String(p.id)).slice(0, 6); }
/** Notion "percent" number format: 0.25 → 25% */
export function pctFormula(p: any): string {
	return `if(${ref(p.name)} || ${ref(p.name)} == 0, (${ref(p.name)} * 100).round() + "%", "")`;
}

export function pillFormulaName(p: any): string {
	return 'pill_' + hash(String(p.id)).slice(0, 6);
}

const q = (s: string) => JSON.stringify(s);

/** select/status sort in Notion follows the option order, not the alphabet → sort on an index formula */
export const ORDERED_TYPES = new Set(['select', 'status']);
export function ordFormulaName(p: any): string { return 'ord_' + hash(String(p.id)).slice(0, 6); }
export function ordFormula(p: any): string {
	const opts = optionsOf(p);
	let e = String(opts.length);
	for (let i = opts.length - 1; i >= 0; i--) e = `if(${ref(p.name)} == ${q(opts[i].name)}, ${i}, ${e})`;
	return e;
}
const ref = (name: string) => `note[${q(propKey(name))}]`;

/** Bases formula that renders select/status/multi-select values as Notion-colored pills. */
export function pillFormula(p: any): string {
	const opts = optionsOf(p);
	// nested if(): value → color
	let colorExpr = '"default"';
	for (let i = opts.length - 1; i >= 0; i--) colorExpr = `if(VAL == ${q(opts[i].name)}, ${q(opts[i].color || 'default')}, ${colorExpr})`;
	// Notion draws status values as a rounded pill with a coloured dot (select / multi-select: plain pill)
	const cls = p.type === 'status' ? 'n-pill n-pill-status n-pill-' : 'n-pill n-pill-';
	const one = (v: string) => `"<span class='${cls}" + ${colorExpr.replace(/VAL/g, v)} + "'>" + escapeHTML(${v}) + "</span>"`;
	if (p.type === 'multi_select') {
		return `if(${ref(p.name)}, html(list(${ref(p.name)}).map(${one('value')}).join("")), "")`;
	}
	return `if(${ref(p.name)}, html(${one(`${ref(p.name)}.toString()`)}), "")`;
}

function propName(schema: Schema, idOrName: string): any {
	return schema.byId.get(idOrName) || schema.byId.get(decodeURIComponent(idOrName)) || schema.byName.get(idOrName);
}

export interface FilterOut { expr: string | null; simple: SimpleFilter | null }

export function convertFilter(f: any, schema: Schema, ctx: Ctx): FilterOut {
	if (!f) return { expr: null, simple: null };
	for (const k of ['and', 'or'] as const) {
		if (Array.isArray(f[k])) {
			const parts = f[k].map((x: any) => convertFilter(x, schema, ctx)).filter((x: FilterOut) => x.expr);
			if (!parts.length) return { expr: null, simple: null };
			const expr = parts.length === 1 ? parts[0].expr : '(' + parts.map((x: FilterOut) => x.expr).join(k === 'and' ? ' && ' : ' || ') + ')';
			const simple = { [k]: parts.map((x: FilterOut) => x.simple).filter(Boolean) } as SimpleFilter;
			return { expr, simple };
		}
	}
	if (f.timestamp) {
		ctx.warn(`view filter on ${f.timestamp} not converted`);
		return { expr: null, simple: null };
	}
	const p = propName(schema, f.property);
	if (!p) { ctx.warn(`view filter on unknown property ${f.property}`); return { expr: null, simple: null }; }
	const name: string = p.name;
	const r = p.type === 'title' ? 'file.name' : p.liveKey ? `formula.${p.liveKey}` : ref(name);
	const prop = p.type === 'title' ? 'file.name' : propKey(name);
	let type = Object.keys(f).find(k => k !== 'property' && k !== 'type') as string;
	let c: any = f[type];
	if (type === 'formula') { type = Object.keys(c)[0]; c = c[type]; }
	if (type === 'rollup') { const t2 = Object.keys(c)[0]; c = c[t2]; type = Object.keys(c)[0] && typeof c[Object.keys(c)[0]] === 'object' ? Object.keys(c)[0] : 'rich_text'; }
	const op = Object.keys(c || {})[0];
	const v = c?.[op];
	const mk = (expr: string, cond: SimpleCond, value?: unknown): FilterOut => ({ expr, simple: { prop, cond, value } });

	if (op === 'is_empty') return mk(`!${r}`, 'empty');
	if (op === 'is_not_empty') return mk(`${r}`, 'not_empty');

	switch (type) {
		case 'checkbox':
			return v ? mk(`${r} == true`, 'eq', true) : mk(`${r} != true`, 'neq', true);
		case 'select': case 'status': case 'string': case 'rich_text': case 'title': case 'url': case 'email': case 'phone_number':
			if (op === 'equals') return mk(`${r} == ${q(v)}`, 'eq', v);
			if (op === 'does_not_equal') return mk(`${r} != ${q(v)}`, 'neq', v);
			if (op === 'contains') return mk(`${r}.toString().contains(${q(v)})`, 'contains', v);
			if (op === 'does_not_contain') return mk(`!${r}.toString().contains(${q(v)})`, 'not_contains', v);
			if (op === 'starts_with') return mk(`${r}.toString().startsWith(${q(v)})`, 'contains', v);
			if (op === 'ends_with') return mk(`${r}.toString().endsWith(${q(v)})`, 'contains', v);
			break;
		case 'multi_select':
			if (op === 'contains') return mk(`list(${r}).contains(${q(v)})`, 'contains', v);
			if (op === 'does_not_contain') return mk(`!list(${r}).contains(${q(v)})`, 'not_contains', v);
			break;
		case 'number': {
			const ops: Record<string, [string, SimpleCond]> = { equals: ['==', 'eq'], does_not_equal: ['!=', 'neq'], greater_than: ['>', 'gt'], less_than: ['<', 'lt'], greater_than_or_equal_to: ['>=', 'gte'], less_than_or_equal_to: ['<=', 'lte'] };
			if (ops[op]) return mk(`${r} ${ops[op][0]} ${Number(v)}`, ops[op][1], Number(v));
			break;
		}
		case 'relation': {
			const t = ctx.link(v);
			if (!t) { ctx.warn(`relation filter target ${v} not imported`); return { expr: null, simple: null }; }
			if (op === 'contains') return mk(`list(${r}).contains(link(${q(t.path)}))`, 'link_contains', t.path);
			if (op === 'does_not_contain') return { expr: `!list(${r}).contains(link(${q(t.path)}))`, simple: { and: [] } };
			break;
		}
		case 'date': {
			if (op === 'past_week') return mk(`(${r} >= today() - "7d" && ${r} <= today())`, 'date_past_week');
			if (op === 'next_week') return mk(`(${r} >= today() && ${r} <= today() + "7d")`, 'date_next_week');
			if (op === 'this_week') return mk(`(${r} >= today() - "6d" && ${r} <= today() + "6d")`, 'date_this_week'); // approximation
			const REL: Record<string, string> = { today: 'today()', tomorrow: '(today() + "1d")', yesterday: '(today() - "1d")', one_week_ago: '(today() - "7d")', one_week_from_now: '(today() + "7d")', one_month_ago: '(today() - "1M")', one_month_from_now: '(today() + "1M")' };
			const relKey = typeof v === 'string' ? v : (v?.relative ?? v?.type);
			const abs = REL[relKey] ?? (typeof v === 'string' && /^\d{4}-/.test(v) ? `date(${q(v)})` : null);
			const ops: Record<string, [string, SimpleCond]> = { equals: ['==', 'eq'], before: ['<', 'lt'], after: ['>', 'gt'], on_or_before: ['<=', 'lte'], on_or_after: ['>=', 'gte'] };
			if (abs && ops[op]) return mk(`${r} ${ops[op][0]} ${abs}`, ops[op][1], v);
			break;
		}
	}
	ctx.warn(`view filter ${type}.${op} on “${name}” not converted`);
	return { expr: null, simple: null };
}

export interface ViewCtx {
	schema: Schema;
	pills: boolean;
	hasCovers: boolean;
	/** property key → option → Notion color (for chart bar colors) */
	colors?: Record<string, Record<string, string>>;
	/** vault folder of the database rows (form views create notes there) */
	folder?: string;
}

/** Bases view types registered by the plugin for Notion views that core Bases has no equivalent for. */
export const CHART_VIEW = 'notion-chart';
export const CALENDAR_VIEW = 'notion-calendar';
export const FORM_VIEW = 'notion-form';

const FORM_TYPES = new Set(['title', 'rich_text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone_number']);

/** Notion form view → plugin "form" Bases view: a small form that creates a new row note in the database folder
 *  (the API exposes no question list, so every editable property is offered, in schema order). */
function formView(v: NotionObj, vc: ViewCtx): Record<string, unknown> {
	const props = vc.schema.ordered.filter(p => FORM_TYPES.has(p.type) && !p.liveKey);
	const fields = [...props.filter(p => p.type === 'title'), ...props.filter(p => p.type !== 'title')].map(p => {
		const f: Record<string, unknown> = { key: p.type === 'title' ? 'file.name' : propKey(p.name), name: p.name, type: p.type };
		const o = optionsOf(p);
		if (o.length) f.options = o.map(x => x.name);
		return f;
	});
	return { type: FORM_VIEW, name: v.name || 'Form', fields, folder: vc.folder, url: v.url };
}

/** Convert one Notion view to a Bases view object. chart / calendar become the plugin's own Bases view
 *  types (`notion-chart`, `notion-calendar`) so they sit in the same view list (and Notion-style tab bar)
 *  as the database's other views. Returns null for form views (no Obsidian equivalent). */
export function convertView(v: NotionObj, vc: ViewCtx, ctx: Ctx): Record<string, unknown> | null {
	const { schema } = vc;
	const cfg = v.configuration || {};
	const type: string = v.type;
	if (type === 'form') return vc.folder ? formView(v, vc) : null;
	if (type === 'chart' || type === 'calendar') return pluginView(v, vc, ctx);

	const visible: any[] = Array.isArray(cfg.properties)
		? cfg.properties.filter((x: any) => x.visible !== false).map((x: any) => propName(schema, x.property_id)).filter(Boolean)
		: schema.ordered.filter(p => p.type !== 'button');
	if (!visible.find(p => p.type === 'title')) visible.unshift(schema.byName.get(schema.titleName) || { type: 'title', name: schema.titleName });
	// Notion always shows the title first in board/gallery/list cards
	const titleFirst = [visible.find(p => p.type === 'title'), ...visible.filter(p => p.type !== 'title')];
	const order = titleFirst.map(p => columnKey(p, vc.pills));

	const out: Record<string, unknown> = {
		type: 'table',
		name: v.name || type,
	};
	const f = convertFilter(v.filter, schema, ctx);
	if (f.expr) out.filters = { and: [f.expr] };
	out.order = order;

	const sorts = (v.sorts || []).map((s: any) => {
		if (s.timestamp) return { property: s.timestamp === 'created_time' ? 'file.ctime' : 'file.mtime', direction: s.direction === 'descending' ? 'DESC' : 'ASC' };
		const p = propName(schema, s.property);
		if (!p) return null;
		const prop = p.type === 'title' ? 'file.name' : p.liveKey ? `formula.${p.liveKey}` : ORDERED_TYPES.has(p.type) && optionsOf(p).length ? `formula.${ordFormulaName(p)}` : `note.${propKey(p.name)}`;
		return { property: prop, direction: s.direction === 'descending' ? 'DESC' : 'ASC' };
	}).filter(Boolean);

	const group = cfg.group_by;
	const groupProp = group ? propName(schema, group.property_id) : null;
	const groupBy = groupProp ? {
		property: groupProp.type === 'title' ? 'file.name' : groupProp.liveKey ? `formula.${groupProp.liveKey}` : `note.${propKey(groupProp.name)}`,
		direction: group.sort?.type === 'descending' ? 'DESC' : 'ASC',
	} : null;

	switch (type) {
		case 'table': {
			out.type = 'table';
			if (groupBy) out.groupBy = groupBy;
			// Notion column widths (Views API `configuration.properties[].width`, px) → Bases `columnSize`
			// (keys need the note./formula./file. prefix – measured in Obsidian 1.15). Wrap has no Bases equivalent.
			const size: Record<string, number> = {};
			for (const x of Array.isArray(cfg.properties) ? cfg.properties : []) {
				if (x.visible === false || !(Number(x.width) > 0)) continue;
				const p = propName(schema, x.property_id);
				if (!p) continue;
				const k = columnKey(p, vc.pills);
				size[/^(file|formula|note)\./.test(k) ? k : `note.${k}`] = Math.round(Number(x.width));
			}
			if (Object.keys(size).length) out.columnSize = size;
			break;
		}
		case 'board':
			out.type = 'kanban';          // Obsidian ≥ 1.14; older versions fall back to table
			if (groupBy) out.groupBy = groupBy;
			if (groupProp && (group.sort?.type === 'manual' || !group.sort) && optionsOf(groupProp).length) {
				out.groupOrder = [...optionsOf(groupProp).map(o => o.name), ...(group.hide_empty_groups ? [] : [null])];
			}
			if (vc.hasCovers && cfg.cover?.type !== 'none') { out.image = 'note.cover'; out.imageAspectRatio = 0.5; if (cfg.cover_aspect === 'contain') out.imageFit = 'contain'; }
			break;
		case 'gallery':
			out.type = 'cards';
			// Notion card preview settings: cover_size small/medium/large, cover_aspect contain ("Fit image") / cover
			if (vc.hasCovers && cfg.cover?.type !== 'none') { out.image = 'note.cover'; out.imageFit = cfg.cover_aspect === 'contain' ? 'contain' : 'cover'; out.imageAspectRatio = cfg.card_layout === 'compact' ? 1.45 : 0.6; }
			{ const size = cfg.cover_size || cfg.card_size; out.cardSize = size === 'small' ? 160 : size === 'large' ? 300 : size === 'medium' ? 220 : cfg.card_layout === 'compact' ? 150 : 220; }
			if (groupBy) out.groupBy = groupBy;
			break;
		case 'list':
			out.type = 'list';
			if (groupBy) out.groupBy = groupBy;
			break;
		case 'timeline': {
			// no timeline in core Bases: a date-sorted table
			out.type = 'table';
			const dp = propName(schema, cfg.date_property_id || cfg.start_date_property_id || '');
			if (dp && !sorts.length) sorts.push({ property: `note.${propKey(dp.name)}`, direction: 'ASC' });
			break;
		}
		default:
			ctx.warn(`view type ${type} → table`);
	}
	if (sorts.length) out.sort = sorts;
	return out;
}

/** chart / calendar → plugin Bases view. The view filter is a normal Bases filter (Bases applies it). */
function pluginView(v: NotionObj, vc: ViewCtx, ctx: Ctx): Record<string, unknown> | null {
	const { schema } = vc;
	const cfg = v.configuration || {};
	const out: Record<string, unknown> = { type: v.type === 'chart' ? CHART_VIEW : CALENDAR_VIEW, name: v.name || v.type };
	const f = convertFilter(v.filter, schema, ctx);
	if (f.expr) out.filters = { and: [f.expr] };
	if (v.type === 'chart') {
		const x = propName(schema, cfg.x_axis?.property_id || '');
		if (!x) { ctx.warn(`chart “${v.name}”: x axis not found`); return null; }
		Object.assign(out, {
			chartType: cfg.chart_type || 'column',
			x: x.type === 'title' ? 'file.name' : x.liveKey ? `formula.${x.liveKey}` : `note.${propKey(x.name)}`, xType: x.type,
			dateGroup: cfg.x_axis?.group_by, aggregate: cfg.y_axis?.aggregator || 'count',
			xSort: cfg.x_axis?.sort?.type,
			colors: optionsOf(x).length ? Object.fromEntries(optionsOf(x).map(o => [o.name, o.color || 'default'])) : undefined,
		});
	} else {
		const dp = propName(schema, cfg.date_property_id || '');
		if (!dp) { ctx.warn(`calendar “${v.name}”: date property not found`); return null; }
		Object.assign(out, { date: dp.liveKey ? `formula.${dp.liveKey}` : `note.${propKey(dp.name)}`, range: cfg.view_range || 'month' });
	}
	return out;
}
