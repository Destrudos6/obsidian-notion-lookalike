// Tiny deterministic YAML writer for frontmatter and .base files (no dependency on Obsidian's stringifyYaml,
// so the converter runs in plain Node for tests).

const PLAIN = /^[A-Za-z0-9_\u00C0-\uFFFF][A-Za-z0-9_ .\-\u00C0-\uFFFF]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/i;

export function yamlScalar(v: unknown): string {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
	const s = String(v);
	if (s === '') return '""';
	if (PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(' ') && !/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
	// dates are fine unquoted too, but quoting keeps them strings for Obsidian? Obsidian parses
	// ISO dates in frontmatter itself, so leave ISO-like values unquoted.
	if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return s;
	return JSON.stringify(s);
}

function key(k: string): string {
	return PLAIN.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
}

export function toYaml(value: unknown, indent = 0): string {
	const pad = '  '.repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return pad + '[]\n';
		return value.map(item => {
			if (item !== null && typeof item === 'object') {
				const inner = toYaml(item, indent + 1).replace(/^\s+/, '');
				return `${pad}- ${inner}`;
			}
			return `${pad}- ${yamlScalar(item)}\n`;
		}).join('');
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		if (entries.length === 0) return pad + '{}\n';
		return entries.map(([k, v]) => {
			if (Array.isArray(v)) {
				if (v.length === 0) return `${pad}${key(k)}: []\n`;
				return `${pad}${key(k)}:\n${toYaml(v, indent + 1)}`;
			}
			if (v !== null && typeof v === 'object') {
				return `${pad}${key(k)}:\n${toYaml(v, indent + 1)}`;
			}
			return `${pad}${key(k)}: ${yamlScalar(v)}\n`;
		}).join('');
	}
	return pad + yamlScalar(value) + '\n';
}

export function frontmatter(obj: Record<string, unknown>): string {
	const body = toYaml(obj);
	return `---\n${body}---\n`;
}
