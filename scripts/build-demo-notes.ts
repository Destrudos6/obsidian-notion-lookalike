// Test fixtures (round 6: moved out of the delivered sample vault): two demo notes used for screenshots and
// manual checks — `Icon link demo.md` (typed wikilinks get page icons) and `Backup fidelity demo.md`
// (synthetic Notion API objects: comments, escaping, unknown blocks).
// usage: node --experimental-strip-types scripts/build-demo-notes.ts [outDir=test/demo-notes]
import fs from 'node:fs';
import path from 'node:path';
import { convertSnapshot } from '../src/core/convert.ts';

const OUT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '../test/demo-notes'));
fs.mkdirSync(OUT, { recursive: true });
// demo note (not from Notion): plain wikilinks typed by hand also get the linked page's Notion icon
fs.writeFileSync(path.join(OUT, 'Icon link demo.md'), `# Icon link demo\n\nPlain wikilinks typed in a normal note get the linked page's Notion icon (reading view + Live Preview):\n\n- Area: [[Notion/Home Hub/Databases/Areas/Work|Work]] and [[Notion/Home Hub/Databases/Areas/Health|Health]]\n- Project: [[Notion/Home Hub/Databases/Projects/Learn Rust|Learn Rust]]\n- Page: [[Notion/Home Hub|Home Hub]] · [[Notion/Reading List|Reading List]]\n- No icon: [[Notion/_导入报告|import report]]\n\n\`\`\`\n[[Notion/Home Hub]] inside code: no icon\n\`\`\`\n`);
// demo note (synthetic Notion API objects): what round 4 keeps that used to be lost
{
	const ann = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
	const t = (s: string) => ({ type: 'text', text: { content: s, link: null }, annotations: ann, plain_text: s, href: null });
	const b = (id: string, type: string, data: any, children?: any[]) => ({ id, type, [type]: data, has_children: !!children, children });
	const pid = 'dddddddd-0000-4000-8000-000000000001';
	const page = { object: 'page', id: pid, created_time: '2026-11-07T02:00:00.000Z', last_edited_time: '2026-11-08T01:30:00.000Z', url: 'https://www.notion.so/dddddddd000040008000000000000001', parent: { type: 'workspace', workspace: true }, icon: { type: 'emoji', emoji: '🛟' }, properties: { title: { id: 'title', type: 'title', title: [t('Backup fidelity demo')] } } };
	const blocks = [
		b('b1', 'paragraph', { rich_text: [t('Literal text stays literal: price $5 and $6, <div> tag, *not italic*, [[not a link]], %%not hidden%%, ==not marked==')] }),
		b('b2', 'paragraph', { rich_text: [t('1. this line is text, not a list')] }),
		b('b3', 'paragraph', { rich_text: [t('Mentions: '), { type: 'mention', mention: { type: 'date', date: { start: '2026-11-07T02:00:00.000Z', end: null } }, plain_text: 'x', annotations: ann }, t(' · '), { type: 'mention', mention: { type: 'page', page: { id: 'eeeeeeee-0000-4000-8000-000000000002' } }, plain_text: 'A page not shared with the integration', annotations: ann }] }),
		b('b4', 'meeting_notes', { title: [t('Weekly sync (a block type this importer does not know)')] }, [b('b5', 'paragraph', { rich_text: [t('Its text and children are still here.')] })]),
		b('b6', 'template', { rich_text: [t('New task')] }, [b('b7', 'to_do', { rich_text: [t('content inside a legacy template button')], checked: false })]),
		b('b8', 'paragraph', { rich_text: [t('This paragraph has a comment.')] }),
	];
	const comments = {
		[pid]: [{ id: 'c1', discussion_id: 'd1', created_time: '2026-11-07T03:00:00.000Z', created_by: { object: 'user', id: 'u1' }, rich_text: [t('Page-level comment: remember to review.')] }],
		b8: [{ id: 'c2', discussion_id: 'd2', created_time: '2026-11-07T04:15:00.000Z', created_by: { object: 'user', id: 'u1' }, rich_text: [t('Block comment on that paragraph.')] }, { id: 'c3', discussion_id: 'd2', created_time: '2026-11-07T04:20:00.000Z', created_by: { object: 'user', id: 'u1' }, rich_text: [t('A reply in the same thread.')] }],
	};
	const demo = convertSnapshot({ roots: [pid], pages: { [pid]: { page, blocks } }, databases: {}, comments, users: { u1: { id: 'u1', name: 'Alex Doe' } } } as any, { targetFolder: '', timeZone: 'Asia/Shanghai' });
	fs.writeFileSync(path.join(OUT, 'Backup fidelity demo.md'), demo.files[0].content);
}
console.log('demo notes →', OUT);
