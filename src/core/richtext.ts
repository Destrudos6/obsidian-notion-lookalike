/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Ctx } from './context.ts';
import type { NotionObj } from './types.ts';
import { colorClass, isoToLocal, normId } from './util.ts';

export interface RTOptions {
	/** keep text / background colors as <span>/<mark> (false for frontmatter values) */
	colors?: boolean;
	/** escape pipes for table cells */
	inTable?: boolean;
	/** escape Markdown / HTML syntax in plain text (default true; false for frontmatter values) */
	escape?: boolean;
}

/** Which characters need escaping depends on the whole block, not one text run: `$5` alone is never math and one
 *  backtick never opens a code span, so `$` / `` ` `` are escaped only when the block has two or more of them. */
export interface EscapeScope { dollar: boolean; tick: boolean; star?: boolean; under?: boolean; eq?: boolean; tilde?: boolean }
const count = (t: string, re: RegExp) => (t.match(re) || []).length;
export function escapeScope(text: string): EscapeScope {
	// Obsidian (unlike strict CommonMark) also makes emphasis of intraword `_x_` and spaced `* x *` (measured in
	// Obsidian 1.15), so `*` / `_` are escaped whenever the block has a second one that could close them.
	return { dollar: count(text, /\$/g) >= 2, tick: count(text, /`/g) >= 2, star: count(text, /\*/g) >= 2, under: count(text, /_/g) >= 2, eq: count(text, /==/g) >= 2, tilde: count(text, /~~/g) >= 2 };
}

/** Make literal Notion text render literally in Obsidian: `*x*`, `[[x]]`, `$5 and $6`, `<tag>`, `==x==`, `%%x%%`
 *  would otherwise turn into formatting, links, math, hidden HTML or comments (text that silently disappears).
 *  Round 6: escape only where a character can actually start Markdown/Obsidian syntax (backslashes show up in
 *  Live Preview on the line being edited, so every unnecessary one is noise). A run edge counts as "unknown
 *  neighbour" → escaped, because the next run (other formatting) may complete the syntax. */
export function escapeMd(s: string, scope: EscapeScope = { dollar: true, tick: true, star: true, under: true, eq: true, tilde: true }): string {
	// bare URLs stay untouched (Obsidian auto-links them; a backslash would end up inside the link)
	return s.split(/(https?:\/\/[^\s<>"]+)/).map((part, i) => (i % 2 ? part : escapePlain(part, scope))).join('');
}

const PUNCT = /[!-/:-@[-`{-~]/;          // ASCII punctuation (CommonMark backslash-escapable)
const SPACE = /\s/;

function escapePlain(s: string, scope: EscapeScope): string {
	let out = '';
	const at = (i: number) => (i < 0 || i >= s.length ? null : s[i]);
	for (let i = 0; i < s.length; i++) {
		const c = s[i], prev = at(i - 1), next = at(i + 1);
		let esc = false;
		switch (c) {
			case '\\': esc = next === null || PUNCT.test(next); break;                       // C:\Users stays as is
			case '`': esc = scope.tick; break;
			case '$': esc = scope.dollar; break;
			case '*': esc = scope.star !== false; break;                                       // one lone "*" is literal
			case '_': esc = scope.under !== false; break;                                      // file_name (one "_") is literal
			case '[': esc = next === null || next === '[' || next === '^'; break;             // [[link]], [^footnote]
			case ']': esc = next === null || next === '(' || next === '[' || next === ']'; break; // [x](url), [x][ref]
			case '~': esc = scope.tilde !== false && (next === '~' || prev === '~'); break;     // ~~strike~~ (3~5 stays)
			case '<': esc = next === null || /[A-Za-z/!?]/.test(next); break;                   // <div>, <!-- -->; "a < b" stays
			case '=': esc = scope.eq !== false && (next === '=' || prev === '='); break;        // ==highlight== ("a == b" stays)
			case '%': esc = next === '%' || prev === '%'; break;                                // %%comment%%
			case '#': esc = (prev === null || SPACE.test(prev)) && next !== null && !SPACE.test(next) && next !== '#'; break; // #tag
			case '^': esc = prev !== null && SPACE.test(prev) && /^\^[A-Za-z0-9-]+\s*$/.test(s.slice(i)); break; // trailing " ^blockid"
			case '&': esc = /^&#?\w+;/.test(s.slice(i)); break;                                 // &amp; entities
		}
		out += esc ? (c === '&' ? '&amp;' : '\\' + c) : c;
	}
	return out;
}

/** Line-level escapes for a block's text: Markdown block syntax at the start of a line (Notion text "1. x", "# x",
 *  "- x", "> x", "---", leading spaces = code block in Markdown). */
export function escapeLineStart(line: string): string {
	let l = line.replace(/^( +)/, m => '&nbsp;'.repeat(m.length));
	l = l.replace(/^(#{1,6})(\s|$)/, '\\$1$2').replace(/^>/, '\\>');
	l = l.replace(/^(\d+)([.)])(\s|$)/, '$1\\$2$3').replace(/^([-+*])(\s|$)/, '\\$1$2').replace(/^([-=_]{3,}\s*)$/, '\\$1');
	l = l.replace(/^\[([ xX])\]/, '\\[$1]');   // "[ ] x" would become a checkbox inside a list item
	return l;
}

function wrapKeepingSpace(text: string, open: string, close: string): string {
	const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
	if (!m || !m[2]) return text;
	return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function notionPageIdFromHref(href: string): string | null {
	// /<id>, https://www.notion.so/xxx-<32hex>, https://app.notion.com/p/<32hex>
	const m = href.match(/([0-9a-f]{32})(?:[?#].*)?$/i) || href.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	if (!m) return null;
	if (href.startsWith('/') || /notion\.(so|site|com)/.test(href)) return normId(m[1]);
	return null;
}

function mention(r: any, ctx: Ctx): string {
	const m = r.mention || {};
	switch (m.type) {
		case 'page': return ctx.linkOrUrl(m.page.id, r.plain_text);
		case 'database': {
			const t = ctx.link(m.database.id);
			return t ? `[[${t.path}|${t.title}]]` : ctx.linkOrUrl(m.database.id, r.plain_text);
		}
		case 'data_source': {
			const id = m.data_source?.id;
			const t = id ? ctx.link(id) : undefined;
			return t ? `[[${t.path}|${t.title}]]` : (id ? ctx.linkOrUrl(id, r.plain_text) : r.plain_text);
		}
		case 'date': {
			const d = m.date || {};
			const f = (x: string) => isoToLocal(x, ctx.tz).replace('T', ' ');
			if (!d.start) return r.plain_text;
			return `<span class="n-mention-date">@${f(d.start)}${d.end ? ' → ' + f(d.end) : ''}${d.time_zone ? ` (${d.time_zone})` : ''}</span>`;
		}
		case 'user': return '@' + (ctx.userName(m.user) || r.plain_text.replace(/^@/, ''));
		case 'template_mention': {
			const tm = m.template_mention || {};
			return `<span class="n-mention-template">${tm.type === 'template_mention_user' ? '@me' : '@' + (tm.template_mention_date || 'today')}</span>`;
		}
		case 'custom_emoji': return r.plain_text || '';
		case 'link_preview':
		case 'link_mention': {
			const url = m.link_preview?.url || m.link_mention?.href || r.href;
			const title = m.link_mention?.title || r.plain_text || url;
			return url ? `[${title}](${url})` : r.plain_text;
		}
		default: return r.plain_text || '';
	}
}

export function richText(rts: NotionObj[] | undefined, ctx: Ctx, o: RTOptions = {}): string {
	if (!rts || !rts.length) return '';
	const colors = o.colors !== false;
	const esc = o.escape !== false;
	// equations / code spans add their own `$…$` / `…` delimiters, which a lone literal `$` or backtick could pair with
	const scope = escapeScope(rts.map((r: any) => (r.type === 'equation' ? '$$' : r.annotations?.code ? '``' : r.type === 'text' ? (r.plain_text ?? r.text?.content ?? '') : '')).join(''));
	return rts.map((r: any) => {
		const a = r.annotations || {};
		let text: string;
		if (r.type === 'equation') return `$${(r.equation?.expression || '').trim()}$`;
		if (r.type === 'mention') text = mention(r, ctx);
		else {
			text = r.plain_text ?? r.text?.content ?? '';
			if (a.code) text = wrapKeepingSpace(text, text.includes('`') ? '`` ' : '`', text.includes('`') ? ' ``' : '`');
			else if (esc) text = escapeMd(text, scope);
			if (o.inTable) text = text.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
		}
		if (!text) return '';
		const cls = colors ? colorClass(a.color) : null;
		if (cls) text = wrapKeepingSpace(text, cls.startsWith('n-bg') ? `<mark class="${cls}">` : `<span class="${cls}">`, cls.startsWith('n-bg') ? '</mark>' : '</span>');
		if (a.underline) text = wrapKeepingSpace(text, '<u>', '</u>');
		if (a.strikethrough) text = wrapKeepingSpace(text, '~~', '~~');
		if (a.italic) text = wrapKeepingSpace(text, '*', '*');
		if (a.bold) text = wrapKeepingSpace(text, '**', '**');
		const href: string | null = r.type === 'text' ? (r.text?.link?.url || r.href) : null;
		if (href) {
			const pid = notionPageIdFromHref(href);
			const wl = pid ? ctx.wikilink(pid, r.plain_text) : null;
			text = wl ?? `[${text}](${href.startsWith('/') ? 'https://www.notion.so' + href : href})`;
		}
		return text;
	}).join('');
}
