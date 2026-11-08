// The Markdown the "/" menu inserts — the importer's own conventions (src/core/blocks.ts), kept in one pure module
// so a test can prove new blocks and imported blocks are the same syntax. CUR marks where the cursor goes.
export const CUR = '\uE000';
export const MD = {
	toggle: (level = 0): string[] => [`> [!toggle${level ? '-h' + level : ''}]- ${CUR}`, '> '],
	callout: (meta = 'gray-bg', icon = '💡'): string[] => [`> [!notion-callout|${meta}] ${icon}`, `> ${CUR}`],
	columns: (n: number): string[] => {
		const out = [`> [!notion-columns|${n}]`];
		for (let i = 0; i < n; i++) { if (i) out.push('>'); out.push('> > [!notion-column]', i === 0 ? `> > ${CUR}` : '> > '); }
		return out;
	},
	toc: (): string[] => ['```notion-toc', '```', CUR],
	linkToPage: (link: string): string[] => ['↗ ' + link + CUR],
};
