// Pure trigger detection for the "/" block menu and "@" mentions (no Obsidian imports → unit-testable).
// Chinese input: '、' (what the "/" key types in a Chinese IME) and full-width '／' open the block menu too,
// '＠' opens mentions. They work anywhere in a line, also right after CJK text ("读书、"). Detection never edits text;
// only *selecting* a menu item removes the trigger + query. To keep a normal '、' usable the menu closes (returns null)
// when the query contains punctuation / whitespace, or when it has no match.

export const SLASH_CHARS = '/、／';
export const MENTION_CHARS = '@＠';

export interface Trigger { start: number; query: string; char: string }

/** query characters: letters, digits, CJK, '-', '_' (punctuation or whitespace ends the menu) */
const QCHAR = /[\p{L}\p{N}_-]/u;

/** true when position `at` of `before` is inside inline code, a URL, a link target, a wiki link or an HTML tag */
export function inProtectedSpan(before: string, at: number): boolean {
	const head = before.slice(0, at);
	// inline code: odd number of unescaped backticks before
	const ticks = (head.replace(/\\`/g, '').match(/`/g) || []).length;
	if (ticks % 2 === 1) return true;
	// the token (since the last whitespace) the trigger sits in
	const tok = head.slice(Math.max(head.lastIndexOf(' '), head.lastIndexOf('\t'), head.lastIndexOf('\u3000')) + 1);
	if (/[a-z][a-z0-9+.-]*:\/\//i.test(tok) || /(^|[^\p{L}])www\./iu.test(tok) || /^[a-z][a-z0-9+.-]*:$/i.test(tok)) return true;
	// markdown link target  ](…   and unclosed [[ … or HTML tag < …
	const lastOpenParen = head.lastIndexOf('](');
	if (lastOpenParen >= 0 && head.indexOf(')', lastOpenParen) < 0) return true;
	const lw = head.lastIndexOf('[[');
	if (lw >= 0 && head.indexOf(']]', lw) < 0) return true;
	const lt = head.lastIndexOf('<');
	if (lt >= 0 && head.indexOf('>', lt) < 0 && /^<\/?[a-z]/i.test(head.slice(lt) + before.charAt(at + 1))) return true;
	return false;
}

function find(before: string, chars: string, maxQuery: number, asciiBlocks: RegExp): Trigger | null {
	// walk back over query characters to the trigger
	let i = before.length;
	let n = 0;
	while (i > 0 && n <= maxQuery) {
		const ch = before.charAt(i - 1);
		if (chars.includes(ch)) break;
		if (!QCHAR.test(ch)) return null;
		i--; n++;
	}
	if (i === 0 || n > maxQuery) return null;
	const at = i - 1;
	const char = before.charAt(at);
	const prev = at > 0 ? before.charAt(at - 1) : '';
	// half-width trigger right after ASCII text = a path, fraction, "and/or", e-mail … → not a menu
	if ((char === '/' || char === '@') && asciiBlocks.test(prev)) return null;
	if (prev && chars.includes(prev)) return null; // "//", "、、", "@@"
	if (inProtectedSpan(before, at)) return null;
	return { start: at, query: before.slice(i), char };
}

/** "/" menu trigger in the text before the cursor, or null */
export function slashTrigger(before: string): Trigger | null {
	return find(before, SLASH_CHARS, 24, /[A-Za-z0-9.:_~\-\\]/);
}

/** "@" mention trigger in the text before the cursor, or null */
export function mentionTrigger(before: string): Trigger | null {
	return find(before, MENTION_CHARS, 30, /[A-Za-z0-9._%+\-]/);
}

/** true when line `line` of the document is inside front matter or a fenced code block */
export function inBlockCode(getLine: (i: number) => string, line: number): boolean {
	let fence = false, fm = false;
	for (let i = 0; i < line; i++) {
		const l = getLine(i);
		if (i === 0 && l === '---') { fm = true; continue; }
		if (fm) { if (l === '---') fm = false; continue; }
		if (/^\s*(```|~~~)/.test(l)) fence = !fence;
	}
	return fence || fm;
}
