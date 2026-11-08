// Page display settings of the "···" menu (Notion: font, small text, full width, lock page) are cssclasses in the
// note's frontmatter. They are local-only: a re-sync from Notion keeps them (carried over into the new content) and
// they never count as a "local edit" (no backup copy just because a page was set to full width).
// Edits are minimal text edits of the frontmatter (Obsidian's processFrontMatter would re-serialise all of it).

export const DISPLAY_CLASSES = ['notion-full-width', 'notion-font-serif', 'notion-font-mono', 'notion-small-text', 'notion-locked'];
export const DISPLAY_KEYS = ['notion-cover-position'];

const FM = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

function splitFm(text: string): { fm: string[] | null; rest: string } {
	const m = FM.exec(text);
	if (!m) return { fm: null, rest: text };
	return { fm: m[1].split(/\r?\n/), rest: text.slice(m[0].length) };
}
const join = (fm: string[], rest: string) => `---\n${fm.join('\n')}\n---\n${rest}`;

/** classes listed under `cssclasses:` (block list, inline [a, b] or a single value) */
export function cssClasses(text: string): string[] {
	const { fm } = splitFm(text);
	if (!fm) return [];
	const i = fm.findIndex(l => /^cssclasses:/.test(l));
	if (i < 0) return [];
	const inline = fm[i].replace(/^cssclasses:\s*/, '');
	if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
	const out: string[] = [];
	for (let j = i + 1; j < fm.length && /^\s+-\s/.test(fm[j]); j++) out.push(fm[j].replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
	return out;
}

/** add / remove one css class with a minimal edit (creates the frontmatter / key when needed) */
export function setCssClass(text: string, cls: string, on: boolean): string {
	const { fm, rest } = splitFm(text);
	const has = cssClasses(text).includes(cls);
	if (has === on) return text;
	if (!fm) return on ? join(['cssclasses:', `  - ${cls}`], text) : text;
	const i = fm.findIndex(l => /^cssclasses:/.test(l));
	if (i < 0) { if (on) fm.push('cssclasses:', `  - ${cls}`); return join(fm, rest); }
	const inline = fm[i].replace(/^cssclasses:\s*/, '');
	if (inline) {
		const list = cssClasses(text).filter(c => c !== cls);
		if (on) list.push(cls);
		fm.splice(i, 1, 'cssclasses:', ...list.map(c => `  - ${c}`));
		if (!list.length) fm.splice(i, 1);
		return join(fm, rest);
	}
	let j = i + 1;
	while (j < fm.length && /^\s+-\s/.test(fm[j])) j++;
	if (on) fm.splice(j, 0, `  - ${cls}`);
	else {
		const k = fm.findIndex((l, n) => n > i && n < j && l.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '') === cls);
		if (k > 0) fm.splice(k, 1);
		if (j - i === 2 && k > 0) fm.splice(i, 1);   // list became empty
	}
	return join(fm, rest);
}

/** the display settings of a note */
export function displayOf(text: string): { classes: string[]; keys: Record<string, string> } {
	const classes = cssClasses(text).filter(c => DISPLAY_CLASSES.includes(c));
	const keys: Record<string, string> = {};
	const { fm } = splitFm(text);
	for (const l of fm || []) { const m = /^([\w-]+):\s*(.*)$/.exec(l); if (m && DISPLAY_KEYS.includes(m[1])) keys[m[1]] = m[2]; }
	return { classes, keys };
}

/** the note without its display settings (what the importer wrote, if nothing else was edited) */
export function withoutDisplay(text: string): string {
	let t = text;
	for (const c of DISPLAY_CLASSES) t = setCssClass(t, c, false);
	const { fm, rest } = splitFm(t);
	if (!fm) return t;
	const kept = fm.filter(l => !DISPLAY_KEYS.some(k => l.startsWith(k + ':')));
	return kept.length === fm.length ? t : join(kept, rest);
}

/** carry display settings over into freshly converted content */
export function withDisplay(text: string, d: { classes: string[]; keys: Record<string, string> }): string {
	let t = text;
	for (const c of d.classes) t = setCssClass(t, c, true);
	const ks = Object.entries(d.keys);
	if (!ks.length) return t;
	const { fm, rest } = splitFm(t);
	if (!fm) return t;
	for (const [k, v] of ks) if (!fm.some(l => l.startsWith(k + ':'))) fm.push(`${k}: ${v}`);
	return join(fm, rest);
}
