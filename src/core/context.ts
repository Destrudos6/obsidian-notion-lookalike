/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AssetRequest, ConvertOptions, NotionObj } from './types.ts';
import { defaultTimeZone, extOf, hash, joinPath, normId, notionUrl, stripQuery } from './util.ts';
import { newAudit, type Audit } from './audit.ts';

export interface LinkTarget {
	path: string;      // vault path without extension (".md" implied) – for .base files the full path incl. ".base"
	title: string;
	kind: 'page' | 'base';
	icon?: string;     // emoji, or vault path / URL of an image icon
}

export class Ctx {
	links = new Map<string, LinkTarget>();
	assets = new Map<string, AssetRequest>();
	warnings: string[] = [];
	/** database id → info needed by child_database blocks */
	dbRender = new Map<string, (indent: string) => string[]>();
	colors: Record<string, Record<string, string>> = {};
	audit: Audit = newAudit();
	users: Record<string, NotionObj> = {};

	opts: ConvertOptions;
	constructor(opts: ConvertOptions) { this.opts = opts; }

	get tz(): string { return this.opts.timeZone || defaultTimeZone(); }

	/** Wikilink when the page was imported, otherwise a Markdown link to the page in Notion (never dropped). */
	linkOrUrl(id: string, label?: string): string {
		const wl = this.wikilink(id, label);
		if (wl) return wl;
		this.audit.unresolvedLinks++;
		return `[${(label || 'Notion 页面').replace(/[[\]]/g, ' ')}](${notionUrl(id)})`;
	}

	userName(u: NotionObj): string {
		if (!u) return '';
		return u.name || this.users[u.id]?.name || (u.person?.email) || this.users[u.id]?.person?.email || u.id || '';
	}

	warn(msg: string): void {
		if (!this.warnings.includes(msg)) this.warnings.push(msg);
	}

	link(id: string): LinkTarget | undefined {
		return this.links.get(normId(id));
	}

	/** Wikilink to a page id, or null when the page was not imported. */
	wikilink(id: string, label?: string): string | null {
		const t = this.link(id);
		if (!t) return null;
		const text = (label ?? t.title).replace(/[[\]|]/g, ' ');
		return `[[${t.path}|${text}]]`;
	}

	/** Map a Notion file object / url to something usable in Markdown: vault path for Notion-hosted files,
	 *  the URL for external ones. */
	file(fileObj: NotionObj): { target: string; local: boolean } | null {
		if (!fileObj) return null;
		if (fileObj.type === 'external') {
			const url: string = fileObj.external?.url || '';
			// Notion's built-in gallery covers/icons (notion.so/images/…) → download, so the vault works offline
			if (/^\/images\//.test(url) || /^https:\/\/(www\.notion\.so|app\.notion\.com|notion\.so)\/images\//.test(url)) {
				return { target: this.asset(url.startsWith('/') ? 'https://www.notion.so' + url : url), local: true };
			}
			return { target: url, local: false };
		}
		if (fileObj.type === 'file' || fileObj.type === 'file_upload') {
			const url: string = fileObj.file?.url || fileObj.file_upload?.url;
			if (!url) return null;
			return { target: this.asset(url), local: true };
		}
		return null;
	}

	asset(url: string): string {
		const key = stripQuery(url);
		const existing = this.assets.get(key);
		if (existing) return existing.path;
		const path = assetPath(key, this.opts);
		this.assets.set(key, { url, key, path });
		return path;
	}
}

export function iconOf(obj: NotionObj, ctx: Ctx): { emoji?: string; image?: string } {
	const icon = obj?.icon;
	if (!icon) return {};
	if (icon.type === 'emoji') return { emoji: icon.emoji };
	if (icon.type === 'external' || icon.type === 'file' || icon.type === 'file_upload') {
		const f = ctx.file(icon);
		return f ? { image: f.target } : {};
	}
	if (icon.type === 'custom_emoji') return icon.custom_emoji?.url ? { image: ctx.asset(icon.custom_emoji.url) } : {};
	if (icon.type === 'icon') return { emoji: '▪️' }; // Notion built-in monochrome icon: no URL in API
	return {};
}

/** Value written to the `notion-icon` frontmatter key: emoji, [[vault/path.png]] or https URL. */
export function iconValue(obj: NotionObj, ctx: Ctx): string | undefined {
	const ic = iconOf(obj, ctx);
	if (ic.emoji) return ic.emoji;
	if (ic.image) return /^https?:/.test(ic.image) ? ic.image : `[[${ic.image}]]`;
	return undefined;
}

/** Deterministic vault path of a downloaded file (same function in the crawler-time downloader and the converter,
 *  so files can be saved the moment their signed URL is seen). */
export function assetPath(urlOrKey: string, opts: Pick<ConvertOptions, 'targetFolder' | 'attachmentsFolder'>): string {
	const key = stripQuery(urlOrKey);
	let last = key.split('/').pop() || 'file';
	try { last = decodeURIComponent(last); } catch { /* keep */ }
	const base = last.replace(/[^\w.\-\u00C0-\uFFFF]+/g, '_');
	const stem = base.replace(/\.[^.]+$/, '').slice(0, 40) || 'file';
	return joinPath(opts.targetFolder, opts.attachmentsFolder, `${stem}-${hash(key)}${hash('~' + key).slice(0, 4)}.${extOf(key)}`);
}

/** Every Notion-hosted file URL inside any API object (blocks, pages, rows, icons, covers, files properties, comments). */
export function collectFileUrls(obj: unknown, out: string[] = [], external = false): string[] {
	if (Array.isArray(obj)) { for (const x of obj) collectFileUrls(x, out, external); return out; }
	if (!obj || typeof obj !== 'object') return out;
	const o = obj as Record<string, any>;
	if ((o.type === 'file' && typeof o.file?.url === 'string')) out.push(o.file.url);
	else if (o.type === 'file_upload' && typeof o.file_upload?.url === 'string') out.push(o.file_upload.url);
	else if (typeof o.url === 'string' && typeof o.expiry_time === 'string' && !o.type) { /* {url, expiry_time} inside a file object: handled by the parent */ }
	else if (o.category && typeof o.file?.url === 'string') out.push(o.file.url);    // comment attachments
	else if (o.type === 'external' && typeof o.external?.url === 'string' && (external || /notion\.so\/images\//.test(o.external.url) || /^\/images\//.test(o.external.url))) out.push(o.external.url.startsWith('/') ? 'https://www.notion.so' + o.external.url : o.external.url);
	for (const [k, v] of Object.entries(o)) if (k !== 'file' && k !== 'external' && v && typeof v === 'object') collectFileUrls(v, out, external);
	return out;
}
