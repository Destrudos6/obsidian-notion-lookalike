// Notion "blocks" on top of plain Markdown lines – pure (no Obsidian, no CodeMirror), unit-tested.
// A block is what Notion's ⋮⋮ handle grabs: a heading, a paragraph, a whole callout / toggle / quote (all its "> "
// lines), a fenced code block, a table, a $$ math block, or a list item WITH its indented children. List items are
// blocks at every depth; everything else only at the top level (Notion: blocks inside a callout move with it).
// The importer's conventions (src/core/blocks.ts) are the target syntax: callout `> [!notion-callout|gray-bg] 💡`,
// toggle `> [!toggle]- title`, colours `<span class="n-c-red">` / `<mark class="n-bg-red n-block">`.
import { UNTITLED } from '../core/naming.ts';

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'quote' | 'callout' | 'toggle' | 'code' | 'table' | 'math' | 'hr';
export interface Block { from: number; to: number; kind: BlockKind; indent: string; depth: number }

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const LIST = /^(\s*)([-*+]|\d+[.)])(\s+\[.\])?(\s+|$)/;
const HEADING = /^#{1,6}\s/;
const HR = /^\s{0,3}(\*\s*){3,}$|^\s{0,3}(-\s*){3,}$|^\s{0,3}(_\s*){3,}$/;
const QUOTE = /^\s{0,3}>/;
const TABLE = /^\s*\|/;
const MATH = /^\s*\$\$/;

const blank = (s: string | undefined) => s === undefined || s.trim() === '';
const lead = (s: string) => /^[\t ]*/.exec(s)![0];
const width = (ws: string) => [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);

/** first line after the YAML frontmatter */
export function bodyStart(lines: string[]): number {
	if (lines[0] !== '---') return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i] === '---' || lines[i] === '...') return i + 1;
	return 0;
}

function startsBlock(l: string): boolean {
	return FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || TABLE.test(l) || MATH.test(l) || LIST.test(l) || (HR.test(l) && !/^\s*-\s*$/.test(l));
}

/** end line of the fenced code block that starts at `i` */
function fenceEnd(lines: string[], i: number): number {
	const m = FENCE.exec(lines[i])!;
	const ch = m[2][0], n = m[2].length;
	for (let j = i + 1; j < lines.length; j++) {
		const f = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
		if (f && f[1][0] === ch && f[1].length >= n) return j;
	}
	return lines.length - 1;
}

/** last line of the list item starting at `i` (its continuation lines and indented children included) */
function listEnd(lines: string[], i: number, stop: number): number {
	const w = width(lead(lines[i]));
	let end = i;
	for (let j = i + 1; j < stop; j++) {
		const l = lines[j];
		if (blank(l)) {
			// a blank line belongs to the item only if more of the item follows (indented deeper)
			let k = j + 1; while (k < stop && blank(lines[k])) k++;
			if (k < stop && width(lead(lines[k])) > w) { j = k - 1; continue; }
			break;
		}
		if (width(lead(l)) > w) { end = j; continue; }
		// a lazy continuation line of the item's paragraph (not a new block)
		if (j === end + 1 && !startsBlock(l) && end === i) { end = j; continue; }
		break;
	}
	return end;
}

function kindOfQuote(first: string): BlockKind {
	const m = /^\s{0,3}>\s*\[!([^\]|]+)/.exec(first);
	if (!m) return 'quote';
	return /^toggle/i.test(m[1]) ? 'toggle' : 'callout';
}

/** Parse lines [from, to) at one nesting level; list items recurse into their children. */
function parse(lines: string[], from: number, to: number, depth: number, out: Block[]): void {
	let i = from;
	while (i < to) {
		const l = lines[i];
		if (blank(l)) { i++; continue; }
		const ind = lead(l);
		let end = i, kind: BlockKind;
		if (FENCE.test(l)) { kind = 'code'; end = Math.min(fenceEnd(lines, i), to - 1); }
		else if (MATH.test(l)) { kind = 'math'; end = i; if (!/^\s*\$\$.*\$\$\s*$/.test(l) || l.trim() === '$$') { for (let j = i + 1; j < to; j++) if (/\$\$\s*$/.test(lines[j])) { end = j; break; } } }
		else if (LIST.test(l)) {
			kind = 'list'; end = listEnd(lines, i, to);
			out.push({ from: i, to: end, kind, indent: ind, depth });
			// children: lines after the item line, at a deeper indent
			parse(lines, i + 1, end + 1, depth + 1, out);
			i = end + 1; continue;
		}
		else if (HEADING.test(l)) { kind = 'heading'; }
		else if (HR.test(l)) { kind = 'hr'; }
		else if (QUOTE.test(l)) { kind = kindOfQuote(l); while (end + 1 < to && QUOTE.test(lines[end + 1])) end++; }
		else if (TABLE.test(l)) { kind = 'table'; while (end + 1 < to && TABLE.test(lines[end + 1])) end++; }
		else {
			kind = 'paragraph';
			while (end + 1 < to && !blank(lines[end + 1]) && !startsBlock(lines[end + 1])) end++;
		}
		// only list items are blocks below the top level: other lines nested in a list item belong to that item
		if (depth === 0) out.push({ from: i, to: end, kind, indent: ind, depth });
		i = end + 1;
	}
}

export function parseBlocks(lines: string[]): Block[] {
	const out: Block[] = [];
	parse(lines, bodyStart(lines), lines.length, 0, out);
	return out.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** The block a line belongs to: the innermost block containing it. */
export function blockAt(blocks: Block[], line: number): Block | null {
	let best: Block | null = null;
	for (const b of blocks) if (b.from <= line && line <= b.to && (!best || b.depth > best.depth)) best = b;
	return best;
}

const isList = (b: Block | null | undefined) => b?.kind === 'list';

/**
 * Move block `src` before / after block `target` (both from parseBlocks(text)). The moved lines are kept
 * byte-for-byte, except for the list indentation, which takes the target's when list items are moved among
 * list items (a nested item dropped next to a top-level item becomes top-level, like Notion).
 * Blank-line separators are fixed up only at the two seams.
 */
export function moveBlock(text: string, src: Block, target: Block, where: 'before' | 'after'): string {
	const lines = text.split('\n');
	if (target.from >= src.from && target.to <= src.to) return text;           // into itself
	let moved = lines.slice(src.from, src.to + 1);
	// re-indent list items to the target's level
	const newIndent = isList(src) && isList(target) ? target.indent : isList(src) ? '' : src.indent;
	if (newIndent !== src.indent) moved = moved.map(l => (l.startsWith(src.indent) ? newIndent + l.slice(src.indent.length) : l));

	// 1. take the block out; collapse a double blank line at the seam
	const rest = [...lines.slice(0, src.from), ...lines.slice(src.to + 1)];
	const seam = src.from;
	if (seam < rest.length && blank(rest[seam]) && (blank(rest[seam - 1]) || seam === bodyStart(lines))) rest.splice(seam, 1);

	// 2. the target's lines in the remaining text
	const shift = (i: number) => (i > src.to ? i - (lines.length - rest.length) : i);
	const tFrom = shift(target.from), tTo = shift(target.to);
	const at = where === 'before' ? tFrom : tTo + 1;
	// "after" a list item means after its children too (tTo already covers them)
	const tb = parseBlocks(rest);
	const prevB = blockAt(tb, at - 1), nextB = blockAt(tb, at);
	const tightPrev = isList(src) && isList(prevB);
	const tightNext = isList(src) && isList(nextB);
	const ins: string[] = [];
	if (at > bodyStart(rest) && !blank(rest[at - 1]) && !tightPrev) ins.push('');
	ins.push(...moved);
	if (at < rest.length && !blank(rest[at]) && !tightNext) ins.push('');
	rest.splice(at, 0, ...ins);
	return rest.join('\n');
}

// ------------------------------------------------------------------ turn into / colour / page

export type TurnInto = 'text' | 'h1' | 'h2' | 'h3' | 'todo' | 'bullet' | 'numbered' | 'quote' | 'callout' | 'toggle' | 'code';

/** The block's text as content lines: [lead, ...rest] without its Markdown syntax (children of a list item are
 *  returned de-indented in `rest`). */
export function blockContent(lines: string[], b: Block): { lead: string; rest: string[]; lang?: string } {
	const ls = lines.slice(b.from, b.to + 1);
	const strip = (l: string) => l.replace(/^\s{0,3}> ?/, '');
	switch (b.kind) {
		case 'heading': return { lead: ls[0].replace(/^#{1,6}\s+/, ''), rest: ls.slice(1) };
		case 'list': {
			const first = ls[0].slice(b.indent.length).replace(LIST, '');
			const rest = ls.slice(1).map(l => l.replace(new RegExp(`^${b.indent.replace(/\t/g, '\\t')}(\\t| {1,4})`), ''));
			return { lead: first, rest };
		}
		case 'quote': { const all = ls.map(strip); return { lead: all[0], rest: all.slice(1) }; }
		case 'toggle': case 'callout': {
			const head = /^\s{0,3}>\s*\[![^\]]*\][-+]?\s?(.*)$/.exec(ls[0]);
			const title = head ? head[1] : '';
			const body = ls.slice(1).map(strip);
			if (b.kind === 'toggle') return { lead: title, rest: body };
			// callout: the "title" is the icon; the text is the body
			return { lead: body[0] ?? '', rest: body.slice(1) };
		}
		case 'code': {
			const lang = FENCE.exec(ls[0])![0] ? ls[0].replace(FENCE, '').trim() : '';
			const inner = ls.slice(1, /^\s*(`{3,}|~{3,})\s*$/.test(ls[ls.length - 1]) && ls.length > 1 ? -1 : undefined);
			return { lead: inner[0] ?? '', rest: inner.slice(1), lang };
		}
		default: return { lead: ls[0] ?? '', rest: ls.slice(1) };
	}
}

/** Notion "Turn into": new lines for the block. */
export function turnInto(lines: string[], b: Block, to: TurnInto): string[] {
	const { lead, rest } = blockContent(lines, b);
	const keepIndent = isList(b) ? b.indent : '';
	const indentRest = (r: string[]) => r.map(l => (l === '' ? '' : '    ' + l));
	switch (to) {
		case 'text': return [lead, ...rest];
		case 'h1': case 'h2': case 'h3': return [`${'#'.repeat(Number(to[1]))} ${lead}`, ...(rest.length ? ['', ...rest] : [])];
		case 'todo': return [`${keepIndent}- [ ] ${lead}`, ...indentRest(rest).map(l => (l ? keepIndent + l : l))];
		case 'bullet': return [`${keepIndent}- ${lead}`, ...indentRest(rest).map(l => (l ? keepIndent + l : l))];
		case 'numbered': return [`${keepIndent}1. ${lead}`, ...indentRest(rest).map(l => (l ? keepIndent + l : l))];
		case 'quote': return [lead, ...rest].map(l => (l === '' ? '>' : '> ' + l));
		case 'callout': {
			const meta = b.kind === 'callout' ? (/\[!notion-callout\|([^\]]+)\]/.exec(lines[b.from])?.[1] ?? 'gray-bg') : 'gray-bg';
			const icon = b.kind === 'callout' ? (/\]\s*(.*)$/.exec(lines[b.from])?.[1] || '💡') : '💡';
			return [`> [!notion-callout|${meta}] ${icon}`, ...[lead, ...rest].map(l => (l === '' ? '>' : '> ' + l))];
		}
		case 'toggle': return [`> [!toggle]- ${lead}`, ...(rest.length ? rest : ['']).map(l => (l === '' ? '>' : '> ' + l))];
		case 'code': return ['```', lead, ...rest, '```'];
	}
}

const WRAP = /^<(span|mark) class="n-(?:c|bg)-[a-z]+(?: n-block)?">([\s\S]*)<\/\1>$/;

/** wrap / unwrap the text of one line in the importer's colour markup (null = default colour) */
export function colorText(text: string, color: string | null, bg: boolean): string {
	const m = WRAP.exec(text);
	const inner = m ? m[2] : text;
	if (!color || color === 'default' || !inner.trim()) return inner;
	return bg ? `<mark class="n-bg-${color} n-block">${inner}</mark>` : `<span class="n-c-${color}">${inner}</span>`;
}

/** Notion block colour (text or background). Callouts: background = the callout's own colour. */
export function colorBlock(lines: string[], b: Block, color: string | null, bg: boolean): string[] {
	const ls = lines.slice(b.from, b.to + 1);
	const prefixed = (l: string, re: RegExp) => { const m = re.exec(l); return m ? m[0] + colorText(l.slice(m[0].length), color, bg) : colorText(l, color, bg); };
	switch (b.kind) {
		case 'code': case 'table': case 'math': case 'hr': return ls;
		case 'heading': return [prefixed(ls[0], /^#{1,6}\s+/), ...ls.slice(1)];
		case 'list': return [prefixed(ls[0], new RegExp('^' + b.indent.replace(/\t/g, '\\t') + LIST.source.slice(1).replace('(\\s*)', ''))), ...ls.slice(1)];
		case 'paragraph': return ls.map(l => colorText(l, color, bg));
		case 'callout': {
			if (bg) return [ls[0].replace(/\[!notion-callout\|[^\]]*\]|\[!notion-callout\]/, `[!notion-callout|${color && color !== 'default' ? color + '-bg' : 'plain'}]`), ...ls.slice(1)];
			return [ls[0], ...ls.slice(1).map(l => prefixed(l, /^\s{0,3}> ?/))];
		}
		case 'toggle': return [ls[0].replace(/^(\s{0,3}>\s*\[![^\]]*\][-+]?\s?)(.*)$/, (_a, p: string, t: string) => p + colorText(t, color, bg)), ...ls.slice(1)];
		case 'quote': return ls.map(l => prefixed(l, /^\s{0,3}> ?/));
	}
}

/** plain title for "Turn into page" */
export function plainTitle(s: string): string {
	return s.replace(/<[^>]+>/g, '').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_~`=#>]/g, '').replace(/^\s*(\[.\]\s*)?/, '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '');
}

/** content of a block as a page of its own (de-indented, list syntax kept) */
export function blockAsPage(lines: string[], b: Block): { title: string; body: string } {
	const { lead } = blockContent(lines, b);
	const ls = lines.slice(b.from, b.to + 1).map(l => (l.startsWith(b.indent) ? l.slice(b.indent.length) : l));
	const body = b.kind === 'heading' ? ls.slice(1) : ls;
	return { title: plainTitle(lead) || UNTITLED, body: body.join('\n').replace(/^\n+/, '') + '\n' };
}

/** remove block lines (and one blank seam) – used by "delete", "turn into page" and moving to another page */
export function removeBlock(text: string, b: Block): string {
	const lines = text.split('\n');
	const rest = [...lines.slice(0, b.from), ...lines.slice(b.to + 1)];
	if (blank(rest[b.from - 1]) && blank(rest[b.from]) && b.from < rest.length) rest.splice(b.from, 1);
	return rest.join('\n');
}

/** replace a block's lines */
export function replaceBlock(text: string, b: Block, with_: string[]): string {
	const lines = text.split('\n');
	return [...lines.slice(0, b.from), ...with_, ...lines.slice(b.to + 1)].join('\n');
}

/** duplicate a block right below itself (Notion "Duplicate") */
export function duplicateBlock(text: string, b: Block): string {
	const lines = text.split('\n');
	const copy = lines.slice(b.from, b.to + 1);
	const sep = isList(b) ? [] : [''];
	return [...lines.slice(0, b.to + 1), ...sep, ...copy, ...lines.slice(b.to + 1)].join('\n');
}

/** append a block (as it was, de-indented) at the end of another note's text */
export function appendBlock(target: string, blockLines: string[], indent: string): string {
	const ls = blockLines.map(l => (l.startsWith(indent) ? l.slice(indent.length) : l));
	const t = target.replace(/\s+$/, '');
	return (t ? t + '\n\n' : '') + ls.join('\n') + '\n';
}

// ---------------------------------------------------------------- round 8: move up / down, block links

/** the previous / next block on the same level (same parent block), or null */
export function siblingOf(blocks: Block[], b: Block, dir: -1 | 1): Block | null {
	const parentOf = (x: Block) => { let p: Block | null = null; for (const c of blocks) if (c !== x && c.from <= x.from && c.to >= x.to && c.depth < x.depth && (!p || c.depth > p.depth)) p = c; return p; };
	const par = parentOf(b);
	const sibs = blocks.filter(x => x.depth === b.depth && parentOf(x) === par).sort((a, c) => a.from - c.from);
	const i = sibs.findIndex(x => x.from === b.from && x.to === b.to);
	return i < 0 ? null : sibs[i + dir] ?? null;
}

/** Notion "move block up / down" (Ctrl+Shift+↑/↓, block menu 上移/下移): swaps with the sibling block */
export function moveBlockStep(text: string, b: Block, dir: -1 | 1): { text: string; line: number } | null {
	const blocks = parseBlocks(text.split('\n'));
	const me = blocks.find(x => x.from === b.from && x.to === b.to) ?? b;
	const sib = siblingOf(blocks, me, dir);
	if (!sib) return null;
	const out = moveBlock(text, me, sib, dir < 0 ? 'before' : 'after');
	if (out === text) return null;
	// where the block starts now: find the moved first line nearest to the sibling's position
	const lines = out.split('\n'); const first = text.split('\n')[me.from];
	let line = dir < 0 ? sib.from : me.from;
	for (let d = 0; d < lines.length; d++) { if (lines[line + d] === first) { line += d; break; } if (lines[line - d] === first) { line -= d; break; } }
	return { text: out, line };
}

const INLINE_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
/** Give a block an Obsidian block id (reusing one that is already there) → [[page#^id]] can link to it */
export function ensureBlockId(text: string, b: Block, fresh: string): { text: string; id: string } {
	const lines = text.split('\n');
	if (b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'list') {
		const at = b.kind === 'paragraph' ? b.to : b.from;
		const m = INLINE_ID.exec(lines[at]);
		if (m) return { text, id: m[1] };
		lines[at] = lines[at].replace(/\s+$/, '') + ` ^${fresh}`;
		return { text: lines.join('\n'), id: fresh };
	}
	const next = lines[b.to + 1], next2 = lines[b.to + 2];
	let m = next !== undefined ? /^\^([A-Za-z0-9-]+)\s*$/.exec(next) : null;
	if (m) return { text, id: m[1] };
	m = next !== undefined && next.trim() === '' && next2 !== undefined ? /^\^([A-Za-z0-9-]+)\s*$/.exec(next2) : null;
	if (m) return { text, id: m[1] };
	const ins = ['', `^${fresh}`];
	if (lines[b.to + 1] !== undefined && lines[b.to + 1].trim() !== '') ins.push('');
	lines.splice(b.to + 1, 0, ...ins);
	return { text: lines.join('\n'), id: fresh };
}
