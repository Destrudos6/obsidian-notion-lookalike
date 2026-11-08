/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NotionObj } from './types.ts';

export const normId = (id: string): string => (id || '').replace(/-/g, '').toLowerCase();

export function plain(rt: NotionObj[] | undefined): string {
	return (rt || []).map((r: any) => r.plain_text ?? '').join('');
}

export function sanitizeFileName(name: string): string {
	let s = (name || '').replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
	s = s.replace(/^\.+/, '');
	// Windows: no trailing dots/spaces, no reserved device names (the vault may be synced to Windows)
	s = s.replace(/[. ]+$/, '');
	if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
	// file systems limit names to 255 *bytes*; CJK is 3 bytes/char → cap at ~150 bytes (+ suffix room)
	const enc = new TextEncoder();
	if (enc.encode(s).length > 150) {
		let out = '';
		for (const ch of s) { if (enc.encode(out + ch).length > 147) break; out += ch; }
		s = out.trim() + '…';
	}
	return s || 'Untitled';
}

export function joinPath(...parts: string[]): string {
	return parts.filter(p => p !== undefined && p !== null && p !== '').join('/').replace(/\/+/g, '/');
}

export function stripQuery(url: string): string {
	return (url || '').split('?')[0];
}

export function extOf(url: string): string {
	const m = stripQuery(url).match(/\.([A-Za-z0-9]{1,5})$/);
	return m ? m[1].toLowerCase() : 'bin';
}

/** Small stable hash (FNV-1a, hex) for asset file names. */
export function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, '0');
}

export function pageTitle(page: NotionObj): string {
	const props = page?.properties || {};
	for (const v of Object.values<any>(props)) if (v?.type === 'title') return plain(v.title);
	return '';
}

export function dbTitle(db: NotionObj): string {
	return plain(db?.title);
}

/** Notion color name → css-friendly token. `gray_background` → `bg-gray`, `red` → `c-red`. */
export function colorClass(color: string | undefined): string | null {
	if (!color || color === 'default') return null;
	if (color.endsWith('_background')) return 'n-bg-' + color.replace('_background', '');
	return 'n-c-' + color;
}

export const NOTION_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

/** https://www.notion.so/<32hex> for any page / database / block id (works for pages that were not imported). */
export function notionUrl(id: string): string {
	return 'https://www.notion.so/' + normId(id);
}

/** Display time zone for UTC timestamps (created/edited time). Default = this machine's zone. */
export function defaultTimeZone(): string {
	try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Notion ISO timestamp → Obsidian date / datetime property value.
 *  - date only → "YYYY-MM-DD"
 *  - with an explicit offset (+08:00) → the wall-clock time as written (that is the zone Notion stored it in)
 *  - UTC ("Z", e.g. created_time) → converted to `tz`, so 02:00Z shows as 10:00 in Asia/Shanghai like in Notion
 *  Seconds are kept when non-zero. The exact original string is always kept in the raw JSON backup. */
export function isoToLocal(s: string, tz: string = defaultTimeZone()): string {
	const m = String(s).match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/);
	if (!m) return s;
	if (!m[2]) return m[1];
	if (m[5] === 'Z') {
		const d = new Date(s);
		if (!isNaN(+d)) {
			try {
				const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
					.formatToParts(d).map(p => [p.type, p.value]));
				const sec = parts.second && parts.second !== '00' ? ':' + parts.second : '';
				return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}${sec}`;
			} catch { /* unknown zone → fall through */ }
		}
	}
	return `${m[1]}T${m[2]}:${m[3]}${m[4] && m[4] !== '00' ? ':' + m[4] : ''}`;
}
