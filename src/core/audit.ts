/* eslint-disable @typescript-eslint/no-explicit-any */
// Notion-vs-vault accounting. Every block, property value, comment and file the snapshot contains must be
// accounted for in the output; anything that is not is listed at the top of the import report.
import type { NBlock, Snapshot } from './types.ts';
import { normId } from './util.ts';

export interface Audit {
	renderedBlocks: Set<string>;
	unsupportedBlocks: Record<string, number>;      // rendered as a visible placeholder (+ text + children)
	propsWritten: number;
	propsLive: number;                              // Notion formula / rollup → live Bases formula (value in raw JSON)
	propsEmpty: number;                             // property present but empty in Notion
	propsFallback: Record<string, number>;          // unknown type → kept as JSON text
	unresolvedLinks: number;                        // relation / mention / link to a page outside the import → Notion URL
	commentsRendered: number;
	pagesWritten: number;
	rowsWritten: Record<string, number>;            // data source id → row notes
	orphansPlaced: number;                          // pages only reachable through search, placed by parent or under _Unsorted
	templatesWritten: number;                       // database templates written to <database>/Templates/
}

export const newAudit = (): Audit => ({ renderedBlocks: new Set(), unsupportedBlocks: {}, propsWritten: 0, propsLive: 0, propsEmpty: 0, propsFallback: {},
	unresolvedLinks: 0, commentsRendered: 0, pagesWritten: 0, rowsWritten: {}, orphansPlaced: 0, templatesWritten: 0 });

export function walkBlocks(blocks: NBlock[] | undefined, fn: (b: NBlock) => void): void {
	for (const b of blocks || []) { fn(b); walkBlocks(b.children, fn); }
}

export interface VerifyLine { ok: boolean; what: string; notion: number | string; vault: number | string; note?: string }

export interface VerifyInput {
	snap: Snapshot;
	audit: Audit;
	pageIdsWritten: Set<string>;                // normalized ids of pages / rows written as notes
	blocksExpected: Set<string>;                // block ids inside pages that were written
	commentsExpected: number;
	assetsRequested: number;
	assetsOk: number;
	assetFailures: string[];
	rawSaved?: { pages: number; databases: number };
	markdownCopies?: { expected: number; saved: number };
	/** ids skipped on purpose (ignore list) – not expected in the vault */
	skippedIds?: Set<string>;
}

/** Compare counts; discrepancies first. */
export function verify(v: VerifyInput): VerifyLine[] {
	const s = v.snap;
	const lines: VerifyLine[] = [];
	const pageIds = new Set<string>();
	for (const k of Object.keys(s.pages)) if (!s.pages[k].page?.__error) pageIds.add(normId(k));
	const rowIds = new Set<string>();
	for (const d of Object.values(s.databases)) for (const ds of d.data_sources || []) for (const r of ds.rows || []) rowIds.add(normId(r.id));
	const skipped = v.skippedIds ?? new Set<string>();
	const all = new Set([...pageIds, ...rowIds].filter(id => !skipped.has(id)));
	const skippedHere = [...new Set([...pageIds, ...rowIds])].filter(id => skipped.has(id)).length;
	const missing = [...all].filter(id => !v.pageIdsWritten.has(id));
	lines.push({ ok: missing.length === 0, what: '页面 + 数据库行 (唯一 ID)', notion: all.size, vault: [...all].filter(id => v.pageIdsWritten.has(id)).length,
		note: missing.length ? '缺少: ' + missing.slice(0, 10).join(', ') : undefined });
	if (skippedHere) lines.push({ ok: true, what: '按设置跳过（以后不再同步，原始数据仍在 _raw）', notion: skippedHere, vault: 0 });
	if (s.stats?.searchPages !== undefined) {
		const notCrawled = s.stats.searchPages - [...all].length - skippedHere;
		lines.push({ ok: notCrawled <= 0, what: 'Notion 搜索可见的页面 (含行)', notion: s.stats.searchPages, vault: all.size,
			note: notCrawled > 0 ? `${notCrawled} 个搜索可见页面没有被抓取` : undefined });
	}
	for (const [dsId, n] of Object.entries(s.stats?.rowsReported || {})) {
		if (skipped.has(normId(dsId))) continue;
		const w = v.audit.rowsWritten[normId(dsId)] ?? 0;
		if (w < n) lines.push({ ok: false, what: `数据源 ${dsId} 的行`, notion: n, vault: w });
	}
	const tpl = new Set<string>();
	for (const d of Object.values(s.databases)) for (const ds of d.data_sources || []) for (const t of ds.templates || []) if (!skipped.has(normId(t.id))) tpl.add(normId(t.id));
	if (tpl.size || s.stats?.templatesReported) {
		const missingT = [...tpl].filter(id => !v.pageIdsWritten.has(id));
		lines.push({ ok: missingT.length === 0 && v.audit.templatesWritten >= tpl.size, what: '数据库模板 (Templates 子文件夹)', notion: tpl.size, vault: v.audit.templatesWritten,
			note: missingT.length ? '缺少: ' + missingT.slice(0, 10).join(', ') : undefined });
	}
	if (v.markdownCopies) lines.push({ ok: v.markdownCopies.saved >= v.markdownCopies.expected, what: 'Notion 原生 Markdown 副本 (_raw/markdown)', notion: v.markdownCopies.expected, vault: v.markdownCopies.saved });
	const notRendered = [...v.blocksExpected].filter(id => !v.audit.renderedBlocks.has(id));
	lines.push({ ok: notRendered.length === 0, what: '块 (blocks)', notion: v.blocksExpected.size, vault: v.blocksExpected.size - notRendered.length,
		note: notRendered.length ? '未输出: ' + notRendered.slice(0, 10).join(', ') : undefined });
	const unsup = Object.entries(v.audit.unsupportedBlocks);
	if (unsup.length) lines.push({ ok: true, what: '不支持的块类型 (已保留文字/子块 + 原始 JSON)', notion: unsup.reduce((a, [, n]) => a + n, 0), vault: unsup.map(([t, n]) => `${t}×${n}`).join(', ') });
	lines.push({ ok: v.commentsExpected === v.audit.commentsRendered, what: '评论', notion: v.commentsExpected, vault: v.audit.commentsRendered });
	const fb = Object.entries(v.audit.propsFallback);
	lines.push({ ok: true, what: '属性值 (写入 / 实时公式 / 空)', notion: v.audit.propsWritten + v.audit.propsLive + v.audit.propsEmpty,
		vault: `${v.audit.propsWritten} / ${v.audit.propsLive} / ${v.audit.propsEmpty}` + (fb.length ? `；未知类型按 JSON 保存: ${fb.map(([t, n]) => `${t}×${n}`).join(', ')}` : '') });
	lines.push({ ok: v.assetsOk === v.assetsRequested, what: '附件 (Notion 托管文件)', notion: v.assetsRequested, vault: v.assetsOk,
		note: v.assetFailures.length ? v.assetFailures.slice(0, 20).join('; ') : undefined });
	if (v.audit.unresolvedLinks) lines.push({ ok: true, what: '指向未导入页面的链接 (保留为 Notion 网址)', notion: v.audit.unresolvedLinks, vault: v.audit.unresolvedLinks });
	if (v.rawSaved) lines.push({ ok: v.rawSaved.pages >= pageIds.size, what: '原始 JSON 备份 (页面 / 数据库)', notion: `${pageIds.size} / ${Object.keys(s.databases).length}`, vault: `${v.rawSaved.pages} / ${v.rawSaved.databases}` });
	for (const e of s.errors || []) lines.push({ ok: false, what: '抓取错误', notion: '', vault: '', note: e });
	if (s.complete === false) lines.push({ ok: false, what: '抓取未完成', notion: '', vault: '', note: '导入被取消或出错 —— 这不是完整备份，请重新运行（会从已备份的部分继续）' });
	return lines.sort((a, b) => Number(a.ok) - Number(b.ok));
}

export function verifyMarkdown(lines: VerifyLine[]): string {
	const bad = lines.filter(l => !l.ok);
	const head = bad.length ? `> [!danger] 发现 ${bad.length} 处不一致 —— 请先看这里\n` + bad.map(l => `> - **${l.what}**: ${l.notion === '' && l.vault === '' ? '' : `Notion ${l.notion} → 库中 ${l.vault}`}${l.note ? (l.notion === '' && l.vault === '' ? '' : ' — ') + l.note : ''}`).join('\n') + '\n'
		: '> [!success] 校验通过：Notion 中抓取到的所有页面、块、评论、附件都已写入库中\n';
	const table = ['| 项目 | Notion | Obsidian | 说明 |', '| --- | --- | --- | --- |',
		...lines.map(l => `| ${l.ok ? '✅' : '❌'} ${l.what} | ${l.notion} | ${l.vault} | ${(l.note || '').replace(/\|/g, '\\|').slice(0, 300)} |`)];
	return head + '\n' + table.join('\n') + '\n';
}
