import fs from 'node:fs';
import path from 'node:path';
import type { Snapshot } from '../src/core/types.ts';
import { syntheticSnapshot } from '../test/synthetic-workspace.ts';

/**
 * Snapshot used by the tests and `npm run sample`.
 * Default: the fictional workspace in test/synthetic-workspace.ts (no real data in this repository).
 * Set NOTION_FIXTURES=<dir> to use your own read-only crawl instead (roots.json, pages/*.json, databases/*.json);
 * some assertions in the tests are written for the synthetic workspace and will not hold for other data.
 */
export const FIX = process.env.NOTION_FIXTURES ? path.resolve(process.env.NOTION_FIXTURES) : '';

export function loadSnapshot(): Snapshot {
	if (!FIX) return syntheticSnapshot();
	const roots = JSON.parse(fs.readFileSync(path.join(FIX, 'roots.json'), 'utf8'));
	const pages: Snapshot['pages'] = {};
	for (const f of fs.readdirSync(path.join(FIX, 'pages'))) pages[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(FIX, 'pages', f), 'utf8'));
	const databases: Snapshot['databases'] = {};
	for (const f of fs.readdirSync(path.join(FIX, 'databases'))) databases[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(FIX, 'databases', f), 'utf8'));
	return { roots: roots.pages, pages, databases };
}
