/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion-style view tabs for Obsidian Bases (.base files, ![[x.base]] embeds and ```base``` blocks).
//
// Notion shows a database's views as a row of tabs (view-type icon + name, active one underlined) above the
// table; Bases shows a dropdown. This draws the tab row into the Bases toolbar and switches views through the
// Bases QueryController (selectView / viewName / query.views / events "view-changed").
//
// QueryController is not exported by the API, so its prototype is taken from a throw-away embed component
// (never loaded or attached) and three methods are wrapped to learn which controllers are alive:
//   update      → every render / data change (also re-checks the tab bar after Bases rebuilt its toolbar)
//   onload      → new controller
//   onunload    → forget it
// If anything of that is missing (future Obsidian) the plugin leaves the native dropdown alone.
import { getIcon, Menu, type App, type Plugin, setIcon } from 'obsidian';
import { emojifyText } from './emoji.ts';

/** Notion's view-type icons (Lucide look-alikes; first one that exists in this Obsidian build wins). */
const TYPE_ICONS: Record<string, string[]> = {
	table: ['table'],
	kanban: ['square-kanban', 'kanban-square', 'columns-3'],
	cards: ['layout-grid', 'grid-2x2'],
	list: ['list'],
	'notion-calendar': ['calendar-days', 'calendar'],
	'notion-chart': ['chart-column', 'bar-chart-3', 'bar-chart'],
	'notion-form': ['clipboard-list', 'file-text'],
	map: ['map'],
};
const DONUT_ICONS = ['chart-pie', 'pie-chart'];

interface Ctl {
	viewHeaderEl?: HTMLElement;
	viewName?: string;
	query?: { views?: any[] };
	events?: { on(n: string, cb: () => void): any; offref(r: any): void };
	selectView(name: string): void;
	viewMenu?: { toolbarItem?: { setOpen(b: boolean): void; menu?: any }; promptForAddView?(): void };
	plugin?: { getRegistration?(t: string): { icon?: string; name?: string } | undefined };
}

export class ViewTabs {
	enabled = true;
	private app: App;
	private plugin: Plugin;
	private proto: any = null;
	private restore: (() => void)[] = [];
	private ctls = new Set<Ctl>();
	private refs = new Map<Ctl, any>();
	private pending = new Set<Ctl>();
	private raf = 0;
	private ro: ResizeObserver;
	private mos = new WeakMap<HTMLElement, MutationObserver>();
	private allMos: MutationObserver[] = [];

	constructor(app: App, plugin: Plugin) {
		this.app = app; this.plugin = plugin;
		this.ro = new ResizeObserver(entries => {
			for (const e of entries) {
				const bar = e.target as HTMLElement;
				if (bar.isConnected) this.layout(bar);
			}
		});
	}

	/** the live Bases QueryController whose view contains `el` (private Bases internals; null when unknown) */
	controllerOf(el: Element): any {
		for (const c of this.ctls as Set<any>) {
			const box: HTMLElement | undefined = c.viewContainerEl ?? c.containerEl;
			if (box && box.contains(el)) return c;
		}
		return null;
	}

	load(): boolean {
		const midSession = (this.app.workspace as any).layoutReady === true;
		const ok = this.patch();
		this.plugin.register(() => this.unload());
		// enabled mid-session: embeds already on screen only call update() on their next data change → re-render
		if (ok && midSession) window.setTimeout(() => this.app.workspace.getLeavesOfType('markdown').forEach(l => (l.view as any)?.previewMode?.rerender?.(true)), 50);
		// controllers that existed before the patch (plugin enabled mid-session)
		this.app.workspace.onLayoutReady(() => this.adoptOpen());
		return ok;
	}

	private unload() {
		for (const r of this.restore.splice(0)) r();
		for (const [c, ref] of this.refs) c.events?.offref(ref);
		this.refs.clear();
		this.ro.disconnect();
		for (const m of this.allMos) m.disconnect();
		for (const c of this.ctls) this.strip(c);
		this.ctls.clear();
		cancelAnimationFrame(this.raf);
	}

	/** Find the QueryController prototype and wrap update / onload / onunload. */
	private patch(): boolean {
		try {
			const make = (this.app as any).embedRegistry?.embedByExtension?.base;
			if (!make) return false;
			const fake = { path: '__notion_probe.base', name: '__notion_probe.base', basename: '__notion_probe', extension: 'base', parent: null, stat: { ctime: 0, mtime: 0, size: 0 }, vault: this.app.vault };
			const probe = make({ app: this.app, containerEl: document.createElement('div'), sourcePath: '' }, fake, '');
			const P = probe?.controller && Object.getPrototypeOf(probe.controller);
			if (!P || typeof P.update !== 'function' || typeof P.selectView !== 'function') return false;
			this.proto = P;
			const self = this;
			const wrap = (name: string, after: (c: any) => void) => {
				const own = Object.prototype.hasOwnProperty.call(P, name);
				const orig = P[name];
				P[name] = function (this: any, ...args: any[]) {
					const r = orig?.apply(this, args);
					try { after(this); } catch (e) { console.error('[notion tabs]', e); }
					return r;
				};
				this.restore.push(() => { if (own) P[name] = orig; else delete P[name]; });
			};
			wrap('update', c => self.track(c));
			wrap('onload', c => self.track(c));
			wrap('onunload', c => self.untrack(c));
			return true;
		} catch (e) {
			console.warn('[notion tabs] Bases internals not found, keeping the native view dropdown', e);
			return false;
		}
	}

	private adoptOpen() {
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			const c = (leaf.view as any)?.controller;
			if (c) this.track(c);
		}
	}

	private track(c: Ctl) {
		if (!this.ctls.has(c)) {
			this.ctls.add(c);
			const ref = c.events?.on('view-changed', () => this.schedule(c));
			if (ref) this.refs.set(c, ref);
		}
		this.schedule(c);
	}

	private untrack(c: Ctl) {
		this.ctls.delete(c); this.pending.delete(c);
		const ref = this.refs.get(c); if (ref) { c.events?.offref(ref); this.refs.delete(c); }
	}

	schedule(c: Ctl | null) {
		if (c) this.pending.add(c); else for (const x of this.ctls) this.pending.add(x);
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			const list = [...this.pending]; this.pending.clear();
			for (const x of list) { try { this.ensure(x); } catch (e) { console.error('[notion tabs]', e); } }
		});
	}

	/** re-render every tab bar (setting toggled) */
	refreshAll() { for (const c of this.ctls) { if (!this.enabled) this.strip(c); } this.schedule(null); }

	private strip(c: Ctl) {
		const h = c.viewHeaderEl;
		if (!h) return;
		h.querySelectorAll('.n-view-tabs').forEach(e => e.remove());
		h.removeClass('n-has-tabs');
	}

	private ensure(c: Ctl) {
		const header = c.viewHeaderEl;
		if (!header || !header.isConnected) return;
		if (!this.enabled) { this.strip(c); return; }
		const toolbar = header.querySelector<HTMLElement>('.bases-toolbar');
		const views = c.query?.views || [];
		if (!toolbar || !views.length) return;
		let bar = toolbar.querySelector<HTMLElement>(':scope > .n-view-tabs');
		if (!bar) {
			bar = createDiv({ cls: 'n-view-tabs', attr: { role: 'tablist' } });
			toolbar.prepend(bar);
			bar.addEventListener('click', ev => this.onClick(c, bar!, ev));
			bar.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.onClick(c, bar!, ev); } });
			this.ro.observe(bar);
			// Bases rebuilds toolbar children on some updates → put the bar back
			if (!this.mos.has(toolbar)) {
				const mo = new MutationObserver(() => { if (!toolbar.querySelector(':scope > .n-view-tabs')) this.schedule(c); });
				mo.observe(toolbar, { childList: true });
				this.mos.set(toolbar, mo); this.allMos.push(mo);
			}
		}
		header.addClass('n-has-tabs');
		const active = c.viewName || views[0]?.name;
		const sig = views.map(v => `${v.type}\u0001${v.name}\u0001${this.custom(v) ?? ''}\u0001${v.type === 'notion-chart' ? this.cfg(v, 'chartType') : ''}`).join('\u0002') + '\u0003' + active;
		if (bar.dataset.sig === sig) return;
		bar.dataset.sig = sig;
		bar.empty();
		for (const v of views) {
			const tab = bar.createDiv({ cls: 'n-view-tab' + (v.name === active ? ' is-active' : ''), attr: { role: 'tab', tabindex: '0', 'aria-selected': String(v.name === active), 'data-view': v.name, title: v.name } });
			this.iconInto(tab.createSpan({ cls: 'n-view-tab-icon' }), c, v);
			emojifyText(tab.createSpan({ cls: 'n-view-tab-label', text: v.name }));   // round 8: emoji in view names (Windows tofu)
		}
		const more = bar.createDiv({ cls: 'n-view-tab n-view-tabs-more', attr: { role: 'button', tabindex: '0' } });
		more.style.display = 'none';
		const add = bar.createDiv({ cls: 'n-view-tab n-view-tabs-add', attr: { role: 'button', tabindex: '0', 'aria-label': 'Add view' } });
		setIcon(add, 'plus');
		this.layout(bar);
	}

	private cfg(v: any, key: string): unknown { try { return v.get ? v.get(key) : v.data?.[key]; } catch { return undefined; } }
	/** a view icon set in Notion / by hand: `notionIcon: 📖` on the view */
	private custom(v: any): string | undefined { const s = this.cfg(v, 'notionIcon'); return s ? String(s) : undefined; }

	private iconInto(el: HTMLElement, c: Ctl, v: any) {
		const custom = this.custom(v);
		if (custom && !/^(lucide-)?[a-z0-9-]+$/.test(custom)) { el.setText(custom); el.addClass('is-emoji'); return; }
		const cands = custom ? [custom.replace(/^lucide-/, '')] : v.type === 'notion-chart' && /donut|pie/.test(String(this.cfg(v, 'chartType'))) ? DONUT_ICONS : TYPE_ICONS[v.type] || [];
		const reg = c.plugin?.getRegistration?.(v.type)?.icon;
		for (const id of [...cands, ...(reg ? [reg.replace(/^lucide-/, '')] : []), 'table']) {
			if (getIcon(id)) { setIcon(el, id); return; }
		}
	}

	/** Notion's overflow: as many tabs as fit, the active one always visible, the rest behind "N more…". */
	private layout(bar: HTMLElement) {
		const tabs = Array.from(bar.querySelectorAll<HTMLElement>('.n-view-tab:not(.n-view-tabs-more):not(.n-view-tabs-add)'));
		const more = bar.querySelector<HTMLElement>('.n-view-tabs-more');
		const add = bar.querySelector<HTMLElement>('.n-view-tabs-add');
		if (!more || !add) return;
		tabs.forEach(t => t.removeClass('is-hidden'));
		more.style.display = 'none';
		const avail = bar.clientWidth;
		if (!avail) return;
		const gap = 2;
		const w = tabs.map(t => t.offsetWidth + gap);
		const addW = add.offsetWidth + gap;
		const total = w.reduce((a, b) => a + b, 0) + addW;
		if (total <= avail) return;
		more.style.display = '';
		more.setText('99 more…');
		const moreW = more.offsetWidth + gap;
		const room = avail - moreW - addW;
		const activeIdx = Math.max(0, tabs.findIndex(t => t.hasClass('is-active')));
		const shown = new Set<number>([activeIdx]);
		let used = w[activeIdx];
		// left to right, contiguous; room for the active tab is reserved even when it sits further right
		for (let i = 0; i < tabs.length; i++) {
			if (i === activeIdx) continue;
			if (used + w[i] > room) break;
			shown.add(i); used += w[i];
		}
		let hidden = 0;
		tabs.forEach((t, i) => { if (!shown.has(i)) { t.addClass('is-hidden'); hidden++; } });
		more.setText(`${hidden} more…`);
		if (!hidden) more.style.display = 'none';
	}

	private onClick(c: Ctl, bar: HTMLElement, ev: Event) {
		const t = (ev.target as HTMLElement).closest<HTMLElement>('.n-view-tab');
		if (!t) return;
		ev.preventDefault(); ev.stopPropagation();
		if (t.hasClass('n-view-tabs-add')) { this.openNative(c, bar, t, true); return; }
		if (t.hasClass('n-view-tabs-more')) { this.moreMenu(c, bar, ev as MouseEvent, t); return; }
		const name = t.dataset.view;
		if (!name) return;
		// Notion: clicking the active tab opens its view menu (rename, layout, duplicate, delete…)
		if (t.hasClass('is-active')) { this.openNative(c, bar, t, false); return; }
		this.select(c, bar, name);
	}

	private select(c: Ctl, bar: HTMLElement, name: string) {
		// instant feedback, then let Bases switch (it fires "view-changed" → ensure() re-syncs)
		bar.querySelectorAll('.n-view-tab.is-active').forEach(e => { e.removeClass('is-active'); e.setAttr('aria-selected', 'false'); });
		bar.querySelector(`.n-view-tab[data-view="${CSS.escape(name)}"]`)?.addClass('is-active');
		c.selectView(name);
		this.schedule(c);
	}

	private moreMenu(c: Ctl, bar: HTMLElement, ev: MouseEvent, anchor: HTMLElement) {
		const menu = new Menu();
		bar.querySelectorAll<HTMLElement>('.n-view-tab.is-hidden').forEach(t => {
			const name = t.dataset.view!;
			const v = (c.query?.views || []).find(x => x.name === name);
			menu.addItem(i => {
				i.setTitle(name).onClick(() => this.select(c, bar, name));
				const ic = createSpan(); if (v) this.iconInto(ic, c, v);
				const svg = ic.querySelector('svg');
				const id = svg?.getAttr('class')?.match(/lucide-([a-z0-9-]+)/)?.[1];
				if (id) i.setIcon(id);
			});
		});
		const r = anchor.getBoundingClientRect();
		if (ev.clientX || ev.clientY) menu.showAtMouseEvent(ev); else menu.showAtPosition({ x: r.left, y: r.bottom });
	}

	/** open Bases' own views popover (rename / configure / delete / add) anchored under our tab */
	private openNative(c: Ctl, bar: HTMLElement, anchor: HTMLElement, add: boolean) {
		const item = c.viewMenu?.toolbarItem;
		const native = bar.parentElement?.querySelector<HTMLElement>('.bases-toolbar-views-menu');
		if (!item || !native) return;
		const tb = bar.parentElement!.getBoundingClientRect(); const r = anchor.getBoundingClientRect();
		native.style.left = `${r.left - tb.left}px`;
		native.style.width = `${r.width}px`;
		try { if (add) c.viewMenu!.promptForAddView!(); else item.setOpen(true); } catch (e) { console.error('[notion tabs]', e); }
	}
}
