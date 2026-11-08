/* eslint-disable @typescript-eslint/no-explicit-any */
import { iconOf, type Ctx } from './context.ts';
import { escapeLineStart, richText } from './richtext.ts';
import type { NBlock } from './types.ts';
import { colorClass, notionUrl, plain } from './util.ts';

const LIST = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do']);

const quote = (lines: string[]): string[] => lines.map(l => (l === '' ? '>' : '> ' + l));
const indent = (lines: string[], pad = '    '): string[] => lines.map(l => (l === '' ? '' : pad + l));

/** Wrap a block's whole text in a block-color span (Notion block color). */
function colored(text: string, color?: string): string {
	const cls = colorClass(color);
	if (!cls || !text) return text;
	return cls.startsWith('n-bg') ? `<mark class="${cls} n-block">${text}</mark>` : `<span class="${cls}">${text}</span>`;
}

/** Render a list of sibling blocks into Markdown lines. */
export function renderBlocks(blocks: NBlock[] | undefined, ctx: Ctx): string[] {
	const out: string[] = [];
	let prev: string | null = null;
	for (const b of blocks || []) {
		const lines = renderBlock(b, ctx).flatMap(l => l.split('\n'));
		if (!lines.length) continue;
		const tight = prev !== null && LIST.has(prev) && prev === b.type;
		if (prev !== null && !tight) out.push('');
		out.push(...lines);
		prev = b.type;
	}
	return out;
}

function childrenUnderListItem(b: NBlock, ctx: Ctx): string[] {
	if (!b.children?.length) return [];
	const lines = renderBlocks(b.children, ctx);
	const first = b.children[0];
	const lead = first && !LIST.has(first.type) ? [''] : [];
	return [...lead, ...indent(lines)];
}

function textLines(md: string): string[] {
	// a Notion rich text can contain hard newlines; keep them as Markdown line breaks
	return md.split('\n').map(escapeLineStart);
}

function calloutBlock(head: string, body: string[]): string[] {
	return quote([head, ...body]);
}

function media(b: NBlock, ctx: Ctx, kind: string): string[] {
	const data = b[b.type] || {};
	const f = ctx.file(data);
	const caption = richText(data.caption, ctx);
	if (!f) return [`<!-- ${kind}: no url -->`];
	const out: string[] = [];
	if (f.local) {
		out.push(kind === 'file' ? `![[${f.target}]]` : `![[${f.target}]]`);
	} else if (kind === 'image') {
		out.push(`![${plain(data.caption).replace(/[[\]]/g, '')}](${f.target})`);
	} else if (kind === 'video' && /youtu\.?be|vimeo/.test(f.target)) {
		out.push(`![](${f.target})`);
	} else {
		out.push(`[${plain(data.caption) || data.name || f.target}](${f.target})`);
	}
	if (caption) out.push(`<span class="n-caption">${caption}</span>`);
	return out;
}

export function renderBlock(b: NBlock, ctx: Ctx): string[] {
	if (b.id) ctx.audit.renderedBlocks.add(b.id);
	return renderBlockInner(b, ctx);
}

/** Text of any block type we do not know: every rich_text / caption / title / url found in its payload. */
function anyText(d: any, ctx: Ctx): string[] {
	const out: string[] = [];
	if (!d || typeof d !== 'object') return out;
	for (const [k, v] of Object.entries<any>(d)) {
		if (Array.isArray(v) && v.length && v[0]?.plain_text !== undefined) { const t = richText(v, ctx); if (t) out.push(...textLines(t)); }
		else if ((k === 'title' || k === 'url' || k === 'name' || k === 'expression') && typeof v === 'string' && v) out.push(k === 'url' ? `<${v}>` : v);
	}
	return out;
}

function renderBlockInner(b: NBlock, ctx: Ctx): string[] {
	const t = b.type;
	const d: any = b[t] || {};
	switch (t) {
		case 'paragraph': {
			const txt = richText(d.rich_text, ctx);
			const lines = txt ? textLines(colored(txt, d.color)) : ['&nbsp;'];
			if (b.children?.length) lines.push('', ...indent(renderBlocks(b.children, ctx), '    '));
			return txt || b.children?.length ? lines : [];
		}
		case 'heading_1': case 'heading_2': case 'heading_3': case 'heading_4': {
			const level = Number(t.slice(-1));
			const txt = colored(richText(d.rich_text, ctx), d.color).replace(/\n/g, ' ');
			if (d.is_toggleable) {
				return calloutBlock(`[!toggle-h${level}]- ${txt || ' '}`, renderBlocks(b.children, ctx));
			}
			// a heading that was toggleable once can still own children → keep them under it
			return ['#'.repeat(level) + ' ' + txt, ...(b.children?.length ? ['', ...renderBlocks(b.children, ctx)] : [])];
		}
		case 'bulleted_list_item':
		case 'numbered_list_item':
		case 'to_do': {
			const marker = t === 'bulleted_list_item' ? '- ' : t === 'numbered_list_item' ? '1. ' : (d.checked ? '- [x] ' : '- [ ] ');
			const txt = colored(richText(d.rich_text, ctx), d.color);
			const [first, ...rest] = textLines(txt || ' ');
			return [marker + first, ...indent(rest, '    '), ...childrenUnderListItem(b, ctx)];
		}
		case 'quote': {
			const txt = colored(richText(d.rich_text, ctx), d.color);
			const body = [...textLines(txt)];
			if (b.children?.length) body.push('', ...renderBlocks(b.children, ctx));
			return quote(body);
		}
		case 'toggle': {
			const txt = colored(richText(d.rich_text, ctx), d.color).replace(/\n/g, ' ');
			return calloutBlock(`[!toggle]- ${txt || ' '}`, renderBlocks(b.children, ctx));
		}
		case 'callout': {
			const ic = iconOf(d, ctx);
			const iconMd = ic.emoji ?? (ic.image ? (ic.image.startsWith('http') ? `![](${ic.image})` : `![[${ic.image}|20]]`) : '');
			const meta = (d.color && d.color !== 'default') ? d.color.replace('_background', '-bg') : 'plain';
			const body = textLines(richText(d.rich_text, ctx));
			if (b.children?.length) body.push('', ...renderBlocks(b.children, ctx));
			return calloutBlock(`[!notion-callout|${meta}] ${iconMd || ' '}`, body);
		}
		case 'column_list': {
			const cols = (b.children || []).filter(c => c.type === 'column');
			const inner: string[] = [];
			cols.forEach((c, i) => {
				ctx.audit.renderedBlocks.add(c.id);
				const ratio = c.column?.width_ratio;
				const w = ratio ? `|w${Math.round((ratio * 100) / 5) * 5}` : '';
				if (i > 0) inner.push('');
				inner.push(...quote([`[!notion-column${w}]`, ...renderBlocks(c.children, ctx)]));
			});
			return calloutBlock(`[!notion-columns|${cols.length}]`, inner);
		}
		case 'column': return renderBlocks(b.children, ctx);
		case 'divider': return ['---'];
		case 'code': {
			const lang = (d.language || '').replace('plain text', '').replace(/\s+/g, '-');
			const code = plain(d.rich_text);
			const fence = code.includes('```') ? '~~~~' : '```';
			const out = [fence + lang, ...code.split('\n'), fence];
			const cap = richText(d.caption, ctx);
			if (cap) out.push(`<span class="n-caption">${cap}</span>`);
			return out;
		}
		case 'equation': return ['$$', (d.expression || '').trim(), '$$'];
		case 'image': return media(b, ctx, 'image');
		case 'video': return media(b, ctx, 'video');
		case 'audio': return media(b, ctx, 'audio');
		case 'pdf': return media(b, ctx, 'pdf');
		case 'file': return media(b, ctx, 'file');
		case 'bookmark':
		case 'link_preview':
		case 'embed': {
			const url: string = d.url || '';
			if (!url) return [];
			const cap = richText(d.caption, ctx);
			let host = url;
			try { host = new URL(url).host; } catch { /* keep url */ }
			return calloutBlock(`[!notion-bookmark] [${cap || host}](${url})`, [`<span class="n-url">${url}</span>`]);
		}
		case 'table': {
			const rows = (b.children || []).filter(r => r.type === 'table_row');
			for (const r of rows) ctx.audit.renderedBlocks.add(r.id);
			if (!rows.length) return [];
			const width = d.table_width || rows[0].table_row.cells.length;
			const cell = (c: any[]) => richText(c, ctx, { inTable: true }) || ' ';
			const lines = rows.map(r => '| ' + r.table_row.cells.map(cell).join(' | ') + ' |');
			const sep = '|' + ' --- |'.repeat(width);
			if (d.has_column_header) return [lines[0], sep, ...lines.slice(1)];
			// Markdown needs a header row: use an empty one, hidden by CSS (.n-noheader is not targetable,
			// so we keep an empty header row – visually close to Notion's header-less tables)
			return ['|' + '   |'.repeat(width), sep, ...lines];
		}
		case 'child_page': {
			const t2 = ctx.link(b.id);
			if (!t2) { ctx.audit.unresolvedLinks++; return [`📄 [${(d.title || 'Untitled').replace(/[[\]]/g, ' ')}](${notionUrl(b.id)})`]; }
			// the plugin draws the page's own icon in front of every link; pages without one get Notion's 📄
			return [`${t2.icon ? '' : '📄 '}[[${t2.path}|${t2.title.replace(/[[\]|]/g, ' ')}]]`];
		}
		case 'child_database': {
			const r = ctx.dbRender.get(b.id.replace(/-/g, '').toLowerCase());
			if (r) return r('');
			ctx.warn(`child_database ${b.id} (“${d.title}”) not imported (no access?)`);
			ctx.audit.unresolvedLinks++;
			return [`> [!notion-callout|gray-bg] 🗃️`, `> 数据库「${(d.title || 'Untitled').replace(/[[\]]/g, ' ')}」没有导入（integration 无权访问？）→ [在 Notion 中打开](${notionUrl(b.id)})`];
		}
		case 'link_to_page': {
			const id = d.page_id || d.database_id || d.data_source_id;
			if (!id) return d.comment_id ? [`[💬 Notion 评论](${notionUrl(d.comment_id)})`] : [];
			return ['↗ ' + ctx.linkOrUrl(id, d.page_id ? undefined : '数据库')];
		}
		case 'synced_block': return renderBlocks(b.children, ctx);
		case 'table_of_contents': return ['```notion-toc', '```'];
		case 'breadcrumb': return ['<span class="n-breadcrumb"></span>'];
		case 'template': {
			// legacy template button: its content is real data → keep it, folded
			const txt = richText(d.rich_text, ctx).replace(/\n/g, ' ');
			return calloutBlock(`[!toggle]- ➕ ${txt || '模板'}`, renderBlocks(b.children, ctx));
		}
		default: {
			// never drop a block silently: visible marker + any text it carries + its children (raw JSON is in _raw/)
			const kind = t === 'unsupported' ? `unsupported:${d.block_type || d.type || '?'}` : t;
			ctx.warn(`unsupported block type: ${kind}`);
			ctx.audit.unsupportedBlocks[kind] = (ctx.audit.unsupportedBlocks[kind] || 0) + 1;
			return calloutBlock(`[!notion-callout|gray-bg] ⚠️`, [`<span class="n-unsupported">Obsidian 中没有对应的 Notion 块：${kind}</span>`, ...anyText(d, ctx), ...(b.children?.length ? ['', ...renderBlocks(b.children, ctx)] : []), `[在 Notion 中打开](${notionUrl(b.id)})`]);
		}
	}
}
