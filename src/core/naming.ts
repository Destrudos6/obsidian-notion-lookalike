// One rule for the names of new pages / rows (round 8.1): Notion's 「无标题」, and on a collision
// 「无标题 2」, 「无标题 3」 … (never 「无标题 1」, never 「未命名」 / "Untitled").

export const UNTITLED = '无标题';

/** `base`, else `base 2`, `base 3` … — the first name `taken` says is free */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
	if (!taken(base)) return base;
	for (let n = 2; ; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
}

/** Names Obsidian (any UI language we know) or Bases give a new note: "Untitled", "Untitled 3", 「未命名」, 「未命名 2」, 「未命名文件」 */
export function isDefaultNewName(basename: string): boolean {
	return /^(Untitled|未命名|未命名文件|未命名笔记)( \d+)?$/i.test(basename.trim());
}
