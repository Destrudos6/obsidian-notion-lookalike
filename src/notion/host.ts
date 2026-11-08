import type { App, Plugin, TFile } from 'obsidian';
import type { IconManager } from '../icons.ts';
import type { PageModel, PageNode } from './pages.ts';

/** What the Notion-mode UI needs from the plugin (keeps the modules free of circular imports). */
export interface NotionHost {
	app: App;
	plugin: Plugin;
	icons: IconManager;
	model: PageModel;
	state: {
		treeOrder: Record<string, string[]>;   // parent folder path → ordered child keys
		treeExpanded: string[];                // expanded node keys
		recentEmoji: string[];
	};
	save(): Promise<void>;
	/** folder where top-level pages created in Notion mode go ('' = vault root) */
	topFolder(): string;
	openSearch(): void;
	newPage(parent: PageNode | null, opts?: { newTab?: boolean; link?: boolean }): Promise<TFile | null>;
	openFile(file: TFile, newLeaf?: boolean): Promise<void>;
	reportPath(): string | null;
	openSettings(): void;
	setNotionMode(on: boolean): Promise<void>;
	runCommand(id: string): void;
	pickPage?(title: string, cb: (n: PageNode | null) => void, exclude: PageNode | null): void;
	/** round 7: the Notion id an imported note / .base stands for (null = not from Notion) */
	notionIdOf?(file: TFile): Promise<string | null>;
	/** "以后不再同步": add to / remove from the importer's ignore list */
	setIgnored?(file: TFile, on: boolean): Promise<boolean>;
	isIgnored?(id: string): boolean;
	/** round 8: private-API self-check (features mark what they find) */
	compat?: { ok(id: string): boolean; mark(id: string, ok: boolean): void };
}
