// Full READ-ONLY backup of a Notion workspace with the plugin's own pipeline (crawler → raw → convert → sync →
// verify), outside Obsidian — handy for testing against your own data.
//   NOTION_TOKEN=ntn_… node --experimental-strip-types scripts/live-backup.ts <vaultDir> [--offline] [--full]
// The token is read from the environment only; it is never printed or written to disk by this script.
// Only GET requests and POST /search, POST …/query are sent (enforced below).
import fs from 'node:fs';
import path from 'node:path';
import { NOTION_VERSION, type Transport } from '../src/api/crawler.ts';
import { rebuildFromRaw, runBackup, type Fetcher, type VaultIO } from '../src/pipeline.ts';

if (!process.argv[2] || process.argv[2].startsWith('--')) { console.error('usage: NOTION_TOKEN=… node --experimental-strip-types scripts/live-backup.ts <vaultDir> [--offline] [--full]'); process.exit(2); }
const ROOT = path.resolve(process.argv[2]);
const TOKEN = process.env.NOTION_TOKEN || '';
const offline = process.argv.includes('--offline');
const abs = (p: string) => path.join(ROOT, p);

const io: VaultIO = {
	read: async p => (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null),
	write: async (p, c) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); },
	writeBinary: async (p, d) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), Buffer.from(d)); },
	size: async p => (fs.existsSync(abs(p)) ? fs.statSync(abs(p)).size : -1),
	rename: async (a, b) => { fs.mkdirSync(path.dirname(abs(b)), { recursive: true }); fs.renameSync(abs(a), abs(b)); },
	copy: async (a, b) => { fs.mkdirSync(path.dirname(abs(b)), { recursive: true }); fs.copyFileSync(abs(a), abs(b)); },
	list: async f => (fs.existsSync(abs(f)) ? fs.readdirSync(abs(f)).filter(n => fs.statSync(path.join(abs(f), n)).isFile()).map(n => `${f}/${n}`) : []),
	remove: async p => { if (fs.existsSync(abs(p))) fs.rmSync(abs(p)); },
	listAll: async () => { const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(abs(d) || '.', { withFileTypes: true })) { const q = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== '_raw' && e.name !== '_attachments') walk(q); } else if (/\.(md|base)$/.test(e.name)) out.push(q); } }; walk(''); return out; },
	removeEmptyDir: async d => { try { if (fs.readdirSync(abs(d)).length) return false; fs.rmdirSync(abs(d)); return true; } catch { return false; } },
};

const READ_ONLY = (m: string, p: string) => m === 'GET' || (m === 'POST' && (/\/query$/.test(p) || p === '/search'));
const transport: Transport = async (method, p, body) => {
	if (!READ_ONLY(method, p)) throw new Error('refused non-read request');
	const r = await fetch('https://api.notion.com/v1' + p, { method, headers: { 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
	let json: unknown = null; try { json = await r.json(); } catch { /* */ }
	return { status: r.status, json, headers: Object.fromEntries(r.headers.entries()) };
};
const fetcher: Fetcher = async url => {
	const r = await fetch(url);
	return { status: r.status, data: await r.arrayBuffer(), contentType: r.headers.get('content-type') || undefined };
};

const settings = { target: 'Notion', roots: [], rowBodies: true, comments: 'all' as const, downloadExternal: true, coloredPills: true, staticHeader: false, templates: true, markdownCopy: true, timeZone: 'Asia/Shanghai', fullVerify: process.argv.includes('--full'), pluginVersion: JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version };
const t0 = Date.now();
let last = 0;
const log = (m: string) => { if (Date.now() - last > 5000) { last = Date.now(); console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`); } };
const r = offline ? await rebuildFromRaw(io, fetcher, settings, log) : await runBackup(io, transport, fetcher, settings, log);
console.log('mode', (r.snap as any).syncMode, 'complete', r.complete, 'seconds', Math.round((Date.now() - t0) / 1000));
console.log(JSON.stringify(r.snap.stats));
for (const l of r.lines) console.log(l.ok ? 'OK ' : 'BAD', l.what, '|', l.notion, '→', l.vault, l.note ? '| ' + l.note.slice(0, 200) : '');
if (r.plan) console.log('plan', { writes: r.plan.writes.length, unchanged: r.plan.unchanged.length, backups: r.plan.backups.length, renames: r.plan.renames.length, archive: r.plan.archive.length, kept: r.plan.keptMissing.length, keptLocal: r.plan.keptLocal.length, conflicts: r.plan.conflicts.length });
