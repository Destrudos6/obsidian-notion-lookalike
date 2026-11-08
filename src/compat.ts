/* eslint-disable @typescript-eslint/no-explicit-any */
// Round 8: self-check of the private / undocumented Obsidian internals the plugin uses. Probed at startup (and
// some on first use, e.g. Bases internals that only exist while a database is open). Every feature that uses one
// is guarded and falls back to stock Obsidian behaviour on its own; the settings show a 「兼容性」 list.

export interface CompatFeature { id: string; feature: string; api: string; fallback: string }
export type CompatState = 'ok' | 'missing' | 'unknown';

export const FEATURES: CompatFeature[] = [
	{ id: 'hotkeys', feature: 'Notion 快捷键（Ctrl+P 搜索页面、Ctrl+N 新建页面、块快捷键）', api: 'app.hotkeyManager', fallback: '保留 Obsidian 原来的快捷键；这些功能仍可从命令面板运行' },
	{ id: 'linkConfig', feature: '移动/改名页面时自动更新链接', api: 'vault.getConfig / setConfig', fallback: '按 Obsidian「文件与链接」里的设置处理（可能会弹窗询问）' },
	{ id: 'settings', feature: '从页面树直接打开插件设置', api: 'app.setting', fallback: '提示你到 设置 → 第三方插件 里手动打开' },
	{ id: 'commands', feature: '菜单里执行 Obsidian 命令（如在新窗口打开）', api: 'app.commands.executeCommandById', fallback: '这些菜单项不起作用，可用命令面板代替' },
	{ id: 'bookmarks', feature: '页面树「收藏」', api: 'internalPlugins bookmarks', fallback: '不显示收藏分组' },
	{ id: 'leftSplit', feature: '打开页面树时自动展开左侧栏', api: 'workspace.leftSplit.expand', fallback: '需要手动展开左侧栏' },
	{ id: 'theme', feature: 'Ctrl+Shift+L 切换深色模式', api: 'app.changeTheme / setTheme', fallback: '只临时切换颜色，不改 Obsidian 的外观设置' },
	{ id: 'embed', feature: 'Notion 式视图标签（嵌入在页面里的数据库）', api: 'app.embedRegistry', fallback: '嵌入的数据库显示 Obsidian 原来的视图下拉菜单' },
	{ id: 'submenu', feature: '块菜单的「转换为 ▸」「颜色 ▸」子菜单', api: 'MenuItem.setSubmenu', fallback: '改为在菜单里平铺显示这些选项' },
	{ id: 'tabTitle', feature: '标签页标题前的页面图标', api: 'leaf.tabHeaderInnerTitleEl', fallback: '标签页不显示图标' },
	{ id: 'basesView', feature: '看板/日历/图表视图与视图标签（Bases）', api: 'registerBasesView、controller.view / viewContainerEl', fallback: '使用 Obsidian 自带的 Bases 视图和下拉菜单' },
	{ id: 'basesFormulas', feature: '表格里单选/状态单元格的下拉编辑', api: 'Bases controller.query.formulas', fallback: '单元格只读，可在页面属性里修改' },
	{ id: 'boardItems', feature: '看板卡片拖动换列、点卡片在侧边打开', api: 'Bases controller.view.columns[].items[]', fallback: '卡片按 Obsidian 默认方式打开，拖动不改分组' },
];

const fn = (o: any, k: string) => typeof o?.[k] === 'function';

/** Startup probes (pure: takes the objects, so tests can pass stubs with internals removed) */
export function probe(app: any, deps: { plugin?: any; MenuItem?: any } = {}): Record<string, CompatState> {
	const r: Record<string, CompatState> = {};
	const safe = (id: string, f: () => boolean | undefined) => { try { const v = f(); r[id] = v === undefined ? 'unknown' : v ? 'ok' : 'missing'; } catch { r[id] = 'missing'; } };
	safe('hotkeys', () => { const h = app?.hotkeyManager; return fn(h, 'getDefaultHotkeys') && fn(h, 'addDefaultHotkeys') && fn(h, 'removeDefaultHotkeys'); });
	safe('linkConfig', () => fn(app?.vault, 'getConfig') && fn(app?.vault, 'setConfig'));
	safe('settings', () => fn(app?.setting, 'open') && fn(app?.setting, 'openTabById'));
	safe('commands', () => fn(app?.commands, 'executeCommandById'));
	safe('bookmarks', () => fn(app?.internalPlugins, 'getPluginById') && !!app.internalPlugins.getPluginById('bookmarks'));
	safe('leftSplit', () => fn(app?.workspace?.leftSplit, 'expand'));
	safe('theme', () => fn(app, 'changeTheme') || fn(app, 'setTheme'));
	safe('embed', () => fn(app?.embedRegistry?.embedByExtension, 'base'));
	safe('submenu', () => deps.MenuItem ? fn(deps.MenuItem.prototype, 'setSubmenu') : undefined);
	safe('tabTitle', () => { let seen: boolean | undefined; app?.workspace?.iterateAllLeaves?.((l: any) => { if (seen === undefined && l?.view?.getViewType?.() !== 'empty') seen = l.tabHeaderInnerTitleEl instanceof Object; }); return seen; });
	safe('basesView', () => deps.plugin ? fn(deps.plugin, 'registerBasesView') : undefined);
	r.basesFormulas = 'unknown'; r.boardItems = 'unknown';
	return r;
}

/** live state: startup probes + marks from features the first time they touch an internal */
export class Compat {
	state: Record<string, CompatState> = {};
	constructor(initial: Record<string, CompatState> = {}) { this.state = { ...initial }; }
	ok(id: string) { return this.state[id] !== 'missing'; }
	/** a feature reports what it found when it actually used the internal */
	mark(id: string, ok: boolean) {
		const was = this.state[id];
		this.state[id] = ok ? 'ok' : 'missing';
		if (!ok && was !== 'missing') console.warn(`notion-lookalike: Obsidian internal for “${id}” not found – feature falls back to stock behaviour`);
	}
	rows() { return FEATURES.map(f => ({ ...f, state: this.state[f.id] ?? 'unknown' as CompatState })); }
}
