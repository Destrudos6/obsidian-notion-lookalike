// Emoji as images (like Notion): Windows' system font draws newer emoji (🛟 Emoji 14, 🗄️ with VS16 …) as
// tofu or monochrome boxes, so every emoji the plugin shows as an icon is drawn from a bundled Twemoji SVG
// (jdecked/twemoji, graphics CC-BY 4.0, see LICENSES/). The SVGs + picker names are one deflate-raw blob
// (src/generated/emoji-pack.ts), decoded lazily with DecompressionStream → works offline, no network.
// Falls back to the text emoji when an image is missing or the pack could not be decoded.
import { EMOJI_PACK } from './generated/emoji-pack.ts';

/** picker entry: [emoji, group, English name, Chinese name, English tags, Chinese tags] */
export type EmojiEntry = [string, number, string, string, string, string];
interface Pack { svg: Record<string, string>; list: EmojiEntry[] }

let pack: Pack | null = null;
let loading: Promise<Pack | null> | null = null;
const urls = new Map<string, string>();
const listeners = new Set<() => void>();

export const EMOJI_GROUPS_ZH = ['表情与情感', '人物与身体', '', '动物与自然', '食物与饮料', '旅行与地点', '活动', '物品', '符号', '旗帜'];

/** Decode the bundled pack (once). Resolves to null if this platform cannot decode it (text fallback). */
export function loadEmoji(): Promise<Pack | null> {
	if (pack) return Promise.resolve(pack);
	loading ??= (async () => {
		try {
			const bin = Uint8Array.from(atob(EMOJI_PACK), c => c.charCodeAt(0));
			const ds = new (globalThis as any).DecompressionStream('deflate-raw');
			const text = await new Response(new Blob([bin]).stream().pipeThrough(ds)).text();
			pack = JSON.parse(text) as Pack;
			listeners.forEach(f => { try { f(); } catch { /* ignore */ } });
			return pack;
		} catch (e) {
			console.warn('notion-lookalike: emoji images unavailable, using text emoji', e);
			return null;
		}
	})();
	return loading;
}

export function onEmojiReady(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }
export function emojiLoaded(): boolean { return !!pack; }
export function emojiList(): EmojiEntry[] { return pack?.list ?? []; }

/** Twemoji file name for an emoji string: code points in hex joined by "-", FE0F dropped unless there is a ZWJ. */
export function emojiKey(s: string): string {
	let cps = [...s].map(c => c.codePointAt(0)!);
	if (!cps.includes(0x200d)) cps = cps.filter(c => c !== 0xfe0f);
	return cps.map(c => c.toString(16)).join('-');
}

/** One emoji (incl. ZWJ sequences, keycaps, flags, VS16, skin tones) — global, for scanning text. */
export const EMOJI_RE = /(?:[#*0-9]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic}\uFE0F?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}\uFE0F?(?:\p{Emoji_Modifier})?)*)/gu;

/** true when the whole string is one emoji (an icon value) */
export function isEmoji(s: string): boolean {
	const t = s.trim();
	if (!t || t.length > 16) return false;
	EMOJI_RE.lastIndex = 0;
	const m = EMOJI_RE.exec(t);
	return !!m && m.index === 0 && m[0].length === t.length;
}

function svgText(key: string): string | null {
	const s = pack?.svg[key];
	if (s === undefined) return null;
	return s.startsWith('!') ? s.slice(1) : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">${s}</svg>`;
}

/** Image URL for an emoji, or null (pack not decoded yet / not in the set → caller shows text). */
export function emojiUrl(emoji: string): string | null {
	if (!pack) return null;
	let key = emojiKey(emoji);
	let u = urls.get(key);
	if (u) return u;
	let svg = svgText(key);
	if (!svg && /-fe0f/.test(key)) { key = key.replace(/-fe0f/g, ''); svg = svgText(key); }
	if (!svg) return null;
	u = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	urls.set(emojiKey(emoji), u);
	return u;
}

/** <img> (or text span fallback) for one emoji */
export function emojiEl(emoji: string, cls = 'n-emoji'): HTMLElement {
	const u = emojiUrl(emoji);
	if (!u) { const s = document.createElement('span'); s.className = cls + ' is-text'; s.textContent = emoji; return s; }
	const img = document.createElement('img');
	img.className = cls; img.src = u; img.alt = emoji; img.draggable = false;
	img.setAttribute('aria-label', emoji);
	return img;
}

const SKIP = 'IMG, CODE, PRE, TEXTAREA, INPUT, SCRIPT, STYLE, .cm-content, .n-emoji, [contenteditable="true"], .math, mjx-container';

/** Replace emoji in text nodes under `root` with images (rendered Markdown, callout titles, our own UI).
 *  The text is kept as the image's alt, so copy/select still yields the emoji. */
export function emojifyText(root: Element, scoped = false) {
	if (!pack) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: n => {
			const p = (n as Text).parentElement;
			const c = p?.closest(SKIP);
			// scoped: rendered widgets inside the editor (Live Preview HTML blocks) — only skip matches below `root`
			if (!p || (c && (!scoped || root.contains(c)))) return NodeFilter.FILTER_REJECT;
			EMOJI_RE.lastIndex = 0;
			return EMOJI_RE.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	for (const t of nodes) {
		const s = t.nodeValue || '';
		const frag = document.createDocumentFragment();
		let last = 0; let changed = false;
		EMOJI_RE.lastIndex = 0;
		for (const m of s.matchAll(EMOJI_RE)) {
			const u = emojiUrl(m[0]);
			if (!u) continue;
			if (m.index! > last) frag.append(s.slice(last, m.index));
			frag.append(emojiEl(m[0], 'n-emoji is-inline'));
			last = m.index! + m[0].length; changed = true;
		}
		if (!changed) continue;
		if (last < s.length) frag.append(s.slice(last));
		t.replaceWith(frag);
	}
}
