/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion-style popovers: icon picker (emoji grid with Chinese + English search, recent, random, upload, link,
// remove) and cover picker (colour/gradient gallery, upload, link, remove). Values are stored in the
// importer's frontmatter keys: `notion-icon` (emoji | "[[file]]" | URL) and `cover` ("[[file]]" | URL).
import { type App, Notice, TFile, normalizePath } from 'obsidian';
import { EMOJI_GROUPS_ZH, emojiEl, emojiList, loadEmoji, type EmojiEntry } from '../emoji.ts';
import type { NotionHost } from './host.ts';

export class Popover {
	el: HTMLElement;
	private off: () => void;
	constructor(anchor: HTMLElement | DOMRect, cls: string, width = 408) {
		this.el = document.body.createDiv({ cls: 'n-popover ' + cls });
		this.el.style.width = `${width}px`;
		const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
		const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
		this.el.style.left = `${left}px`;
		const below = r.bottom + 6;
		this.el.style.top = `${below}px`;
		this.el.style.maxHeight = `${Math.max(240, window.innerHeight - below - 12)}px`;
		const onDown = (ev: MouseEvent) => { if (!this.el.contains(ev.target as Node)) this.close(); };
		const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); this.close(); } };
		window.setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
		document.addEventListener('keydown', onKey, true);
		this.off = () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
		Popover.open?.close();
		Popover.open = this;
	}
	static open: Popover | null = null;
	onClose: (() => void) | null = null;
	close() { this.off(); this.el.remove(); this.onClose?.(); if (Popover.open === this) Popover.open = null; }
	tabs(names: string[], onPick: (i: number) => void, right?: { text: string; cb: () => void }[]): HTMLElement {
		const bar = this.el.createDiv({ cls: 'n-pop-tabs' });
		const btns = names.map((n, i) => { const b = bar.createDiv({ cls: 'n-pop-tab', text: n }); b.onclick = () => { btns.forEach(x => x.removeClass('is-active')); b.addClass('is-active'); onPick(i); }; return b; });
		btns[0]?.addClass('is-active');
		const sp = bar.createDiv({ cls: 'n-pop-spacer' }); void sp;
		for (const r of right ?? []) { const b = bar.createDiv({ cls: 'n-pop-tab is-action', text: r.text }); b.onclick = r.cb; }
		return this.el.createDiv({ cls: 'n-pop-body' });
	}
}

async function setFm(app: App, file: TFile, key: string, value: string | null, alsoDelete: string[] = []) {
	await app.fileManager.processFrontMatter(file, fm => {
		for (const k of alsoDelete) delete fm[k];
		if (value === null) delete fm[key]; else fm[key] = value;
	});
}

/** Save an uploaded image next to the note's other attachments (Obsidian's attachment setting decides where). */
async function saveUpload(app: App, file: TFile, f: File): Promise<string> {
	const name = (f.name || 'image.png').replace(/[\\/:*?"<>|#^[\]]/g, '-');
	const path = await app.fileManager.getAvailablePathForAttachment(name, file.path);
	const created = await app.vault.createBinary(path, await f.arrayBuffer());
	return `[[${created.path}]]`;
}

function pickFile(accept: string): Promise<File | null> {
	return new Promise(res => {
		const input = createEl('input', { attr: { type: 'file', accept } });
		input.onchange = () => res(input.files?.[0] ?? null);
		input.click();
	});
}

function search(entries: EmojiEntry[], q: string): EmojiEntry[] {
	const t = q.trim().toLowerCase();
	if (!t) return entries;
	const words = t.split(/\s+/);
	return entries.filter(e => {
		const hay = `${e[2]} ${e[3]} ${e[4]} ${e[5]}`.toLowerCase();
		return words.every(w => hay.includes(w)) || e[0] === q.trim();
	});
}

// ---------------------------------------------------------------- icon picker
export function openIconPicker(host: NotionHost, anchor: HTMLElement, file: TFile) {
	const { app } = host;
	const pop = new Popover(anchor, 'n-icon-picker', 408);
	const ICON_KEYS = ['icon', 'icon-image'];   // older imports: remove them too so the new icon wins
	const choose = async (v: string | null) => {
		await setFm(app, file, 'notion-icon', v, ICON_KEYS);
		if (v && !v.startsWith('[[') && !/^https?:/.test(v)) {
			const r = host.state.recentEmoji.filter(x => x !== v); r.unshift(v); host.state.recentEmoji = r.slice(0, 18); void host.save();
		}
		pop.close();
	};
	const random = () => { const l = emojiList().filter(e => e[1] !== 9); if (l.length) void choose(l[Math.floor(Math.random() * l.length)][0]); };
	const body = pop.tabs(['表情', '上传', '链接'], i => render(i), [{ text: '随机', cb: random }, { text: '移除', cb: () => void choose(null) }]);
	const render = (tab: number) => {
		body.empty();
		if (tab === 0) {
			const search0 = body.createDiv({ cls: 'n-pop-search' });
			const input = search0.createEl('input', { attr: { type: 'text', placeholder: '搜索 emoji（中文或英文）…' } });
			const grid = body.createDiv({ cls: 'n-emoji-grid-wrap' });
			let token = 0;
			const fill = async () => {
				const my = ++token;
				grid.empty();
				await loadEmoji();
				const all = emojiList();
				if (!all.length) { grid.createDiv({ cls: 'n-pop-empty', text: 'emoji 图片不可用' }); return; }
				const q = input.value;
				const sections: [string, EmojiEntry[]][] = [];
				if (!q.trim() && host.state.recentEmoji.length) sections.push(['最近使用', host.state.recentEmoji.map(e => [e, -1, '', '', '', ''] as EmojiEntry)]);
				if (q.trim()) sections.push([`搜索结果`, search(all, q)]);
				else for (let g = 0; g < EMOJI_GROUPS_ZH.length; g++) { const l = all.filter(e => e[1] === g); if (l.length && EMOJI_GROUPS_ZH[g]) sections.push([EMOJI_GROUPS_ZH[g], l]); }
				// a group's images are only created when it scrolls into view (≈1900 SVGs would block the UI)
				io?.disconnect();
				io = new IntersectionObserver(ents => {
					for (const en of ents) {
						if (!en.isIntersecting) continue;
						const g = en.target as HTMLElement & { _list?: EmojiEntry[] };
						io!.unobserve(g);
						g.style.minHeight = '';
						for (const e of g._list ?? []) {
							const b = g.createDiv({ cls: 'n-emoji-btn', attr: { 'aria-label': e[3] || e[2] || e[0] } });
							const im = emojiEl(e[0]);
							if (im instanceof HTMLImageElement) im.decoding = 'async';
							b.appendChild(im);
							b.onclick = () => void choose(e[0]);
						}
					}
				}, { root: grid, rootMargin: '200px 0px' });
				for (const [title, list] of sections) {
					if (my !== token) return;
					grid.createDiv({ cls: 'n-emoji-group', text: title });
					const g = grid.createDiv({ cls: 'n-emoji-grid' }) as HTMLElement & { _list?: EmojiEntry[] };
					if (!list.length) { g.createDiv({ cls: 'n-pop-empty', text: '没有结果' }); continue; }
					g._list = list;
					g.style.minHeight = `${Math.ceil(list.length / 11) * 32}px`;
					io.observe(g);
				}
			};
			let io: IntersectionObserver | null = null;
			pop.onClose = () => io?.disconnect();
			input.addEventListener('input', () => void fill());
			input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { const first = grid.querySelector<HTMLElement>('.n-emoji-btn'); first?.click(); } });
			window.setTimeout(() => input.focus(), 0);
			void fill();
		} else if (tab === 1) {
			const b = body.createEl('button', { cls: 'n-pop-wide-btn mod-cta', text: '上传图片' });
			body.createDiv({ cls: 'n-pop-hint', text: '推荐 280 × 280 像素的正方形图片。图片会保存在库的附件文件夹里。' });
			b.onclick = async () => { const f = await pickFile('image/*'); if (f) await choose(await saveUpload(app, file, f)); };
		} else {
			const inp = body.createEl('input', { cls: 'n-pop-input', attr: { type: 'url', placeholder: '粘贴图片链接…' } });
			const b = body.createEl('button', { cls: 'n-pop-wide-btn mod-cta', text: '确定' });
			b.onclick = () => { const v = inp.value.trim(); if (/^https?:\/\//.test(v)) void choose(v); else new Notice('请输入 http(s) 开头的图片链接'); };
			window.setTimeout(() => inp.focus(), 0);
		}
	};
	render(0);
}

// ---------------------------------------------------------------- cover picker
/** Notion's "Color & Gradient" covers, drawn as small SVG files (stored in the vault like any cover image). */
export const COVERS: { name: string; svg: string }[] = (() => {
	const solid = (c: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="600"><rect width="100%" height="100%" fill="${c}"/></svg>`;
	const grad = (a: string, b: string, angle = 'x2="1" y2="1"') => `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="600"><defs><linearGradient id="g" x1="0" y1="0" ${angle}><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
	return [
		{ name: 'notion-cover-red', svg: solid('#e16259') }, { name: 'notion-cover-yellow', svg: solid('#dfab01') },
		{ name: 'notion-cover-blue', svg: solid('#0b6e99') }, { name: 'notion-cover-green', svg: solid('#0f7b6c') },
		{ name: 'notion-cover-beige', svg: solid('#f7f3e8') }, { name: 'notion-cover-gray', svg: solid('#e3e2e0') },
		{ name: 'notion-gradient-sunset', svg: grad('#f8b195', '#c06c84') }, { name: 'notion-gradient-ocean', svg: grad('#a1c4fd', '#3a6ea5') },
		{ name: 'notion-gradient-mint', svg: grad('#d4fc79', '#4caf8f') }, { name: 'notion-gradient-dusk', svg: grad('#2c3e50', '#8e6fb5') },
		{ name: 'notion-gradient-peach', svg: grad('#ffecd2', '#fcb69f', 'x2="0" y2="1"') }, { name: 'notion-gradient-sky', svg: grad('#e0f2ff', '#89c4f4', 'x2="0" y2="1"') },
	];
})();

async function coverFile(app: App, note: TFile, c: { name: string; svg: string }): Promise<string> {
	const probe = await app.fileManager.getAvailablePathForAttachment(c.name + '.svg', note.path);
	const dir = probe.includes('/') ? probe.slice(0, probe.lastIndexOf('/')) : '';
	const path = normalizePath((dir ? dir + '/' : '') + c.name + '.svg');
	const ex = app.vault.getAbstractFileByPath(path);
	if (!(ex instanceof TFile)) await app.vault.create(path, c.svg);
	return `[[${path}]]`;
}

export function randomCover(app: App, note: TFile): Promise<string> {
	return coverFile(app, note, COVERS[Math.floor(Math.random() * COVERS.length)]);
}

export function openCoverPicker(host: NotionHost, anchor: HTMLElement | DOMRect, file: TFile) {
	const { app } = host;
	const pop = new Popover(anchor, 'n-cover-picker', 540);
	const set = async (v: string | null) => { await setFm(app, file, 'cover', v, v === null ? ['notion-cover-position'] : []); pop.close(); };
	const body = pop.tabs(['图库', '上传', '链接'], i => render(i), [{ text: '移除', cb: () => void set(null) }]);
	const render = (tab: number) => {
		body.empty();
		if (tab === 0) {
			body.createDiv({ cls: 'n-emoji-group', text: '颜色与渐变' });
			const g = body.createDiv({ cls: 'n-cover-grid' });
			for (const c of COVERS) {
				const b = g.createDiv({ cls: 'n-cover-swatch', attr: { 'aria-label': c.name } });
				b.style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.svg)}")`;
				b.onclick = async () => set(await coverFile(app, file, c));
			}
		} else if (tab === 1) {
			const b = body.createEl('button', { cls: 'n-pop-wide-btn mod-cta', text: '上传图片' });
			body.createDiv({ cls: 'n-pop-hint', text: '宽度大于 1500 像素的图片效果最好。图片会保存在库的附件文件夹里。' });
			b.onclick = async () => { const f = await pickFile('image/*'); if (f) await set(await saveUpload(app, file, f)); };
		} else {
			const inp = body.createEl('input', { cls: 'n-pop-input', attr: { type: 'url', placeholder: '粘贴图片链接…' } });
			const b = body.createEl('button', { cls: 'n-pop-wide-btn mod-cta', text: '确定' });
			b.onclick = () => { const v = inp.value.trim(); if (/^https?:\/\//.test(v)) void set(v); else new Notice('请输入 http(s) 开头的图片链接'); };
		}
	};
	render(0);
}

export { setFm };
