/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Ctx } from './context.ts';
import { richText } from './richtext.ts';
import type { NotionObj } from './types.ts';
import { isoToLocal, notionUrl, plain } from './util.ts';

/** Frontmatter keys this importer writes itself; a Notion property with the same name gets renamed. */
export const RESERVED_KEYS = new Set(['cover', 'icon', 'icon-image', 'notion-icon', 'cssclasses', 'notion-id', 'aliases', 'tags', 'notion-db',
	'notion-url', 'notion-created', 'notion-edited', 'notion-title', 'notion-parent']);

export function propKey(name: string): string {
	return RESERVED_KEYS.has(name.toLowerCase()) ? `${name} (Notion)` : name;
}

function dateValue(d: any, ctx?: Ctx): string | null {
	if (!d?.start) return null;
	return normalizeDate(d.start, ctx);
}

/** Notion date → Obsidian date/datetime value (UTC timestamps shown in the display zone, offsets kept as wall-clock). */
export function normalizeDate(s: string, ctx?: Ctx): string {
	return isoToLocal(s, ctx?.tz);
}

function rollupValue(r: any, ctx: Ctx): unknown {
	if (!r) return null;
	switch (r.type) {
		case 'number': return r.number;
		case 'date': return dateValue(r.date, ctx);
		case 'array': {
			const vals = (r.array || []).map((x: any) => propertyValue(x, ctx)).flat().filter((x: unknown) => x !== null && x !== '' && x !== undefined);
			return vals;
		}
		default: return r[r.type] ?? null;   // 'incomplete' / 'unsupported' carry no value
	}
}

/** Convert one Notion property value to a frontmatter value. Returns undefined only for types that carry no data
 *  (title is the file name, button has no value); unknown types are kept as JSON text, never dropped. */
export function propertyValue(p: any, ctx: Ctx): unknown {
	if (!p) return undefined;
	switch (p.type) {
		case 'title': return undefined;
		case 'rich_text': return richText(p.rich_text, ctx, { colors: false, escape: false }) || null;
		case 'number': return p.number;
		case 'select': return p.select?.name ?? null;
		case 'status': return p.status?.name ?? null;
		case 'multi_select': return (p.multi_select || []).map((o: any) => o.name);
		case 'date': return dateValue(p.date, ctx);
		case 'checkbox': return !!p.checkbox;
		case 'url': return p.url ?? null;
		case 'email': return p.email ?? null;
		case 'phone_number': return p.phone_number ?? null;
		case 'people': return (p.people || []).map((u: any) => ctx.userName(u));
		case 'created_by': return ctx.userName(p.created_by) || null;
		case 'last_edited_by': return ctx.userName(p.last_edited_by) || null;
		case 'created_time': return normalizeDate(p.created_time, ctx);
		case 'last_edited_time': return normalizeDate(p.last_edited_time, ctx);
		case 'files': return (p.files || []).map((f: any) => {
			const r = ctx.file(f);
			if (!r) return f?.name || null;
			return r.local ? `[[${r.target}]]` : r.target;
		}).filter(Boolean);
		// a related page that was not imported (not shared with the integration) stays as its Notion URL
		case 'relation': return (p.relation || []).map((r: any) => ctx.wikilink(r.id) ?? (ctx.audit.unresolvedLinks++, notionUrl(r.id)));
		case 'formula': {
			const f = p.formula || {};
			if (f.type === 'string') return f.string ?? null;
			if (f.type === 'number') return f.number;
			if (f.type === 'boolean') return f.boolean;
			if (f.type === 'date') return dateValue(f.date, ctx);
			return null;
		}
		case 'rollup': return rollupValue(p.rollup, ctx);
		case 'unique_id': return p.unique_id ? `${p.unique_id.prefix ? p.unique_id.prefix + '-' : ''}${p.unique_id.number}` : null;
		case 'verification': return p.verification?.state ?? null;
		case 'place': {
			const pl = p.place;
			if (!pl) return null;
			const label = pl.name || pl.address || '';
			return [label, pl.lat !== undefined && pl.lon !== undefined ? `${pl.lat},${pl.lon}` : ''].filter(Boolean).join(' @ ') || null;
		}
		case 'button': return undefined;
		default: {
			const v = p[p.type];
			ctx.audit.propsFallback[p.type] = (ctx.audit.propsFallback[p.type] || 0) + 1;
			ctx.warn(`unknown property type “${p.type}” kept as JSON text`);
			return v === undefined || v === null ? null : JSON.stringify(v);
		}
	}
}

/** Secondary values that need their own key (date range end, date-only time zone). */
export function extraValues(name: string, p: any, ctx?: Ctx): Record<string, unknown> {
	const d = p?.type === 'date' ? p.date : p?.type === 'formula' && p.formula?.type === 'date' ? p.formula.date : null;
	const out: Record<string, unknown> = {};
	if (d?.end) out[`${propKey(name)} (end)`] = normalizeDate(d.end, ctx);
	if (d?.time_zone) out[`${propKey(name)} (time zone)`] = d.time_zone;
	if (p?.type === 'place' && p.place) out[`${propKey(name)} (place)`] = JSON.stringify(p.place);
	return out;
}

const isEmpty = (v: unknown) => v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function rowFrontmatter(page: NotionObj, ctx: Ctx, skip?: Set<string>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, p] of Object.entries<any>(page.properties || {})) {
		if (skip?.has(name)) { ctx.audit.propsLive++; continue; } // live Bases formula: no static copy (Notion's value is in the raw JSON)
		const v = propertyValue(p, ctx);
		if (v === undefined) continue;
		if (isEmpty(v) && p.type !== 'checkbox') ctx.audit.propsEmpty++; else ctx.audit.propsWritten++;
		out[propKey(name)] = v;
		Object.assign(out, extraValues(name, p, ctx));
	}
	return out;
}

export { plain };
