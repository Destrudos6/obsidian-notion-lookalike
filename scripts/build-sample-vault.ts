// Offline harness: fixture snapshot (the fictional workspace in test/synthetic-workspace.ts, or your own read-only
// crawl via NOTION_FIXTURES=<dir>) → sample vault on disk.
import fs from 'node:fs';
import path from 'node:path';
import { rawDbPath, rawPagePath, manifestPath, newManifest } from '../src/core/backup.ts';
import { rebuildFromRaw, type VaultIO } from '../src/pipeline.ts';
import { convertSnapshot } from '../src/core/convert.ts';
import { FIX, loadSnapshot } from './load-fixtures.ts';
const PKG_VERSION: string = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version;

// Same path as a real import: the fixture snapshot is written as the raw backup layer (_raw/), then the
// plugin's offline "rebuild from raw" pipeline converts it, "downloads" files (from fixtures/assets), verifies
// and writes the import report.
const OUT = path.resolve(import.meta.dirname, '../sample-vault');
fs.rmSync(OUT, { recursive: true, force: true });
const abs = (p: string) => path.join(OUT, p);
const io: VaultIO = {
	read: async p => (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null),
	write: async (p, c) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); },
	writeBinary: async (p, d) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), Buffer.from(d)); },
	size: async p => (fs.existsSync(abs(p)) ? fs.statSync(abs(p)).size : -1),
	rename: async (a, b) => { fs.mkdirSync(path.dirname(abs(b)), { recursive: true }); fs.renameSync(abs(a), abs(b)); },
	copy: async (a, b) => { fs.mkdirSync(path.dirname(abs(b)), { recursive: true }); fs.copyFileSync(abs(a), abs(b)); },
	list: async f => (fs.existsSync(abs(f)) ? fs.readdirSync(abs(f)).map(n => `${f}/${n}`) : []),
	remove: async p => { if (fs.existsSync(abs(p))) fs.rmSync(abs(p)); },
	listAll: async () => { const out: string[] = []; const walk = (d: string) => { for (const e of fs.readdirSync(abs(d) || '.', { withFileTypes: true })) { const q = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== '_raw' && e.name !== '_attachments') walk(q); } else if (/\.(md|base)$/.test(e.name)) out.push(q); } }; walk(''); return out; },
	removeEmptyDir: async d => { try { if (fs.readdirSync(abs(d)).length) return false; fs.rmdirSync(abs(d)); return true; } catch { return false; } },
};
const snap = loadSnapshot();
for (const [id, ps] of Object.entries(snap.pages)) await io.write(rawPagePath('Notion', id), JSON.stringify({ ...ps, comments: {} }));
for (const [id, d] of Object.entries(snap.databases)) await io.write(rawDbPath('Notion', id), JSON.stringify(d));
await io.write(manifestPath('Notion'), JSON.stringify({ ...newManifest(snap.roots, new Date().toISOString(), PKG_VERSION), inProgress: false, complete: true }));
// files: from <fixtures>/assets (index.json maps URL → file) when given, else a 1×1 PNG placeholder for every URL
const idx = FIX && fs.existsSync(path.join(FIX, 'assets/index.json')) ? JSON.parse(fs.readFileSync(path.join(FIX, 'assets/index.json'), 'utf8')) : null;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const fetcher = async (url: string) => {
	if (!idx) return { status: 200, data: PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) as ArrayBuffer, contentType: 'image/png' };
	const local = idx[url.split('?')[0]];
	if (!local) return { status: 404, data: new ArrayBuffer(0) };
	const b = fs.readFileSync(path.join(FIX, 'assets', local));
	return { status: 200, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
};
const r = await rebuildFromRaw(io, fetcher, { target: 'Notion', roots: snap.roots, rowBodies: true, comments: 'none', downloadExternal: false, coloredPills: true, staticHeader: false, timeZone: 'Asia/Shanghai', pluginVersion: PKG_VERSION, sleep: async () => {} });
const res = r.res!;
const copied = res.assets.filter(a => fs.existsSync(abs(a.path))).length, missing = res.assets.length - copied;
// (round 6) the two demo notes are test fixtures now: scripts/build-demo-notes.ts → test/demo-notes/ (not in the delivered vault)
const PLUG = path.join(OUT, '.obsidian/plugins/notion-lookalike-importer');
fs.mkdirSync(PLUG, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) if (fs.existsSync(path.resolve(import.meta.dirname, '..', f))) fs.copyFileSync(path.resolve(import.meta.dirname, '..', f), path.join(PLUG, f));
fs.writeFileSync(path.join(OUT, '.obsidian/community-plugins.json'), JSON.stringify(['notion-lookalike-importer']));
fs.writeFileSync(path.join(OUT, '.obsidian/core-plugins.json'), JSON.stringify({ bases: true, 'file-explorer': true, properties: true, outline: true, 'global-search': true, backlink: true }));
for (const l of r.lines) console.log(l.ok ? '  OK ' : '  BAD', l.what, '|', l.notion, '→', l.vault, l.note ? '| ' + l.note.slice(0, 160) : '');
// no data.json: database icons + option colors live in each .base file's `notion:` block (survives Obsidian rewriting it)
console.log(`files ${res.files.length}, assets copied ${copied}, missing ${missing}, warnings ${res.warnings.length}`);
for (const w of res.warnings.slice(0, 30)) console.log('  !', w);
