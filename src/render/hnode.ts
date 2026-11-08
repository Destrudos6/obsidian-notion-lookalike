// Minimal virtual-DOM used by the chart/calendar/header renderers so the same code produces
// real DOM inside Obsidian and an HTML string in the offline preview.
export interface HNode { tag: string; attrs?: Record<string, string | number | undefined>; children?: (HNode | string)[] }

export const h = (tag: string, attrs: HNode['attrs'] = {}, ...children: (HNode | string | null | undefined | false)[]): HNode =>
	({ tag, attrs, children: children.filter((c): c is HNode | string => c !== null && c !== undefined && c !== false) });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toHtml(n: HNode | string): string {
	if (typeof n === 'string') return esc(n);
	const a = Object.entries(n.attrs || {}).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('');
	return `<${n.tag}${a}>${(n.children || []).map(toHtml).join('')}</${n.tag}>`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'g', 'text', 'line']);

export function toDom(n: HNode | string, parent: Node, doc: Document = document): void {
	if (typeof n === 'string') { parent.appendChild(doc.createTextNode(n)); return; }
	const el = SVG_TAGS.has(n.tag) ? doc.createElementNS(SVG_NS, n.tag) : doc.createElement(n.tag);
	for (const [k, v] of Object.entries(n.attrs || {})) if (v !== undefined) el.setAttribute(k, String(v));
	for (const c of n.children || []) toDom(c, el, doc);
	parent.appendChild(el);
}
