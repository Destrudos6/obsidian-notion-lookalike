// Live Preview: emoji in the text are drawn as Twemoji images (like Notion on Windows) while the document
// text stays the real emoji. The line with the cursor/selection shows the plain text (same rule as other
// Live Preview syntax), code and math are left alone.
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { editorLivePreviewField } from 'obsidian';
import { EMOJI_RE, emojiEl, emojiUrl, emojifyText } from './emoji.ts';

class EmojiWidget extends WidgetType {
	e: string;
	constructor(e: string) { super(); this.e = e; }
	eq(o: EmojiWidget) { return o.e === this.e; }
	toDOM() { return emojiEl(this.e, 'n-emoji is-inline is-editor'); }
	ignoreEvent() { return false; }
}

export function emojiEditorExtension(enabled: () => boolean, version: () => number) {
	function build(view: EditorView): DecorationSet {
		const b = new RangeSetBuilder<Decoration>();
		if (!enabled() || !view.state.field(editorLivePreviewField, false)) return b.finish();
		const sel = view.state.selection.ranges;
		const doc = view.state.doc;
		const tree = syntaxTree(view.state);
		for (const { from, to } of view.visibleRanges) {
			const text = doc.sliceString(from, to);
			EMOJI_RE.lastIndex = 0;
			for (const m of text.matchAll(EMOJI_RE)) {
				const a = from + m.index!, z = a + m[0].length;
				if (!emojiUrl(m[0])) continue;
				const la = doc.lineAt(a);
				if (sel.some(r => r.from <= la.to && r.to >= la.from)) continue;   // editing this line → plain text
				const name = tree.resolveInner(a, 1).name;
				if (/code|math|frontmatter|hmd-codeblock|comment/i.test(name)) continue;
				b.add(a, z, Decoration.replace({ widget: new EmojiWidget(m[0]) }));
			}
		}
		return b.finish();
	}
	return ViewPlugin.fromClass(class {
		decorations: DecorationSet; v: number;
		constructor(view: EditorView) { this.decorations = build(view); this.v = version(); this.embeds(view); }
		/** HTML blocks (e.g. `<span class="n-db-title">🧭 Areas</span>`) are drawn by Obsidian as widgets, which our
		 *  replace decorations can't reach → emojify their rendered DOM once it is in the document. */
		embeds(view: EditorView) {
			if (!enabled() || !view.state.field(editorLivePreviewField, false)) return;
			window.setTimeout(() => view.dom.querySelectorAll('.cm-html-embed').forEach(el => emojifyText(el, true)), 50);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged || u.geometryChanged || this.v !== version()) this.embeds(u.view);
			if (u.docChanged || u.viewportChanged || u.selectionSet || this.v !== version() || u.transactions.some(t => t.reconfigured)) {
				this.decorations = build(u.view); this.v = version();
			}
		}
	}, { decorations: v => v.decorations });
}
