// Re-sync conflict dialog: pages / rows changed BOTH in the vault and in Notion since the last sync.
// Safe default for every item = 保留本地 (the Notion version is saved under _同步冲突/ next to nothing being lost).
// Closing the dialog (Esc / ×) also keeps everything local.
import { type App, Modal } from 'obsidian';
import type { ConflictInfo } from '../pipeline.ts';
import type { ConflictChoice } from '../core/backup.ts';

const when = (iso?: string) => {
	if (!iso) return '时间未知（可能是插件升级后转换结果不同）';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso;
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export class ConflictModal extends Modal {
	private items: ConflictInfo[];
	private choice: Record<string, ConflictChoice> = {};
	private done: (c: Record<string, ConflictChoice>) => void;
	constructor(app: App, items: ConflictInfo[], done: (c: Record<string, ConflictChoice>) => void) {
		super(app); this.items = items; this.done = done;
		for (const it of items) this.choice[it.path] = 'local';
	}
	onOpen() {
		this.modalEl.addClass('n-conflict-modal');
		this.titleEl.setText(`有 ${this.items.length} 个页面在两边都改过`);
		const c = this.contentEl;
		c.createEl('p', { cls: 'n-conflict-intro', text: '这些页面上次同步后，你在本地改过，Notion 里也改过。默认保留你的本地版本，Notion 的版本另存一份到「_同步冲突」文件夹；选「用 Notion 覆盖」时，本地版本会先备份到「_本地修改备份」。无论怎么选都不会丢内容。' });
		const list = c.createDiv({ cls: 'n-conflict-list' });
		const selects: HTMLSelectElement[] = [];
		for (const it of this.items) {
			const row = list.createDiv({ cls: 'n-conflict-row' });
			const info = row.createDiv({ cls: 'n-conflict-info' });
			info.createDiv({ cls: 'n-conflict-title', text: it.title });
			info.createDiv({ cls: 'n-conflict-path', text: it.path });
			info.createDiv({ cls: 'n-conflict-what', text: `Notion：修改于 ${when(it.notionEdited)}　·　本地比 Notion 版本多 ${it.added} 行、少 ${it.removed} 行` });
			const sel = row.createEl('select', { cls: 'dropdown n-conflict-choice' });
			sel.createEl('option', { value: 'local', text: '保留本地' });
			sel.createEl('option', { value: 'notion', text: '用 Notion 覆盖' });
			sel.value = 'local';
			sel.onchange = () => { this.choice[it.path] = sel.value as ConflictChoice; };
			selects.push(sel);
		}
		const btns = c.createDiv({ cls: 'modal-button-container' });
		const all = (v: ConflictChoice) => { for (const s of selects) s.value = v; for (const it of this.items) this.choice[it.path] = v; };
		btns.createEl('button', { text: '全部保留本地' }).onclick = () => all('local');
		btns.createEl('button', { text: '全部用 Notion 覆盖' }).onclick = () => all('notion');
		btns.createEl('button', { cls: 'mod-cta', text: '继续同步' }).onclick = () => { this.finish(this.choice); this.close(); };
	}
	private finish(c: Record<string, ConflictChoice>) { const d = this.done; this.done = () => {}; d(c); }
	onClose() {
		// closed without confirming → keep everything local
		this.finish(Object.fromEntries(this.items.map(i => [i.path, 'local' as const])));
		this.contentEl.empty();
	}
}

/** promise wrapper used by the plugin's import */
export const askConflicts = (app: App, items: ConflictInfo[]) => new Promise<Record<string, ConflictChoice>>(res => new ConflictModal(app, items, res).open());
