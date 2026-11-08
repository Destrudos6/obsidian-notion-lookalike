/* eslint-disable @typescript-eslint/no-explicit-any */
/*! @license
 * Notion formula / rollup properties → LIVE Obsidian Bases formulas.
 *
 * Function mapping table and the Notion→Bases correspondences (format→toString, formatDate→format,
 * length→.length, map/filter current→value, test→/re/.matches, dateAdd→date + "Nd", sum/min/max via lists …)
 * are adapted from the official Obsidian Importer, src/formats/notion-api/formula-converter.ts:
 *
 *   MIT License — Copyright (c) 2023 Obsidian
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 *   following conditions: The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. (full text: LICENSES/obsidian-importer-MIT.txt)
 *
 * Differences from the official converter (which rewrites strings with regexes and gives up on ifs/empty/
 * repeat/style/dateBetween/let/rollups): this one parses Notion formula 2.0 into an AST and emits Bases
 * expressions with light type tracking, so it can also handle
 *   ifs → nested if, and/or/not, empty(), repeat(), let/lets, dateBetween → (a - b).days, some/every/find,
 *   style() at the top level → html() with Notion color classes,
 *   rollups → list(note.Relation).map(value.asFile().properties["X"]) …,
 *   references to other formula/rollup properties → formula.<key> (Bases evaluates formula-of-formula).
 * Null handling was checked against a real Obsidian 1.15 (see NOTES.md): `!null` is NOT true and
 * `null.toString()` is "null", so empty values are coalesced with `.isEmpty()` before use.
 */
import type { Schema } from './views.ts';
import { propKey } from './properties.ts';
import { hash } from './util.ts';

export type Kind = 'num' | 'str' | 'bool' | 'date' | 'list' | 'links' | 'html' | 'any';
interface Em { code: string; kind: Kind; nullable: boolean; atom: boolean }

export class Unsupported extends Error {}

// ---------------------------------------------------------------- tokenizer / parser (Notion formula 2.0)
type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string };
type Node =
	| { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'bool'; v: boolean }
	| { k: 'id'; name: string } | { k: 'list'; items: Node[] }
	| { k: 'call'; fn: string; args: Node[] }
	| { k: 'bin'; op: string; a: Node; b: Node } | { k: 'un'; op: string; a: Node }
	| { k: 'index'; a: Node; i: Node };

function lex(s: string): Tok[] {
	const out: Tok[] = []; let i = 0;
	const OPS = ['==', '!=', '>=', '<=', '&&', '||', '>', '<', '+', '-', '*', '/', '%', '^', '!', '(', ')', '[', ']', ',', '.', '?', ':'];
	while (i < s.length) {
		const c = s[i];
		if (/\s/.test(c)) { i++; continue; }
		if (c === '"' || c === '\u201c' || c === '\u201d') {
			let j = i + 1, v = '';
			while (j < s.length && s[j] !== '"' && s[j] !== '\u201d') {
				if (s[j] === '\\' && j + 1 < s.length) { const n = s[j + 1]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; } else v += s[j++];
			}
			if (j >= s.length) throw new Unsupported('unterminated string');
			out.push({ t: 'str', v }); i = j + 1; continue;
		}
		const num = s.slice(i).match(/^(\d+(\.\d+)?([eE][-+]?\d+)?|\.\d+)/);
		if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
		const id = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
		if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
		const op = OPS.find(o => s.startsWith(o, i));
		if (op) { out.push({ t: 'op', v: op }); i += op.length; continue; }
		throw new Unsupported(`unexpected character ${c}`);
	}
	out.push({ t: 'eof', v: '' });
	return out;
}

export function parseFormula(src: string): Node {
	const toks = lex(src); let p = 0;
	const peek = () => toks[p];
	const isOp = (v: string) => peek().t === 'op' && peek().v === v;
	const isWord = (v: string) => peek().t === 'id' && peek().v === v;
	const expect = (v: string) => { if (!isOp(v)) throw new Unsupported(`expected ${v} near "${peek().v}"`); p++; };
	const args = (): Node[] => {
		const a: Node[] = []; expect('(');
		if (!isOp(')')) { a.push(ternary()); while (isOp(',')) { p++; a.push(ternary()); } }
		expect(')'); return a;
	};
	function primary(): Node {
		const t = peek();
		if (t.t === 'num') { p++; return { k: 'num', v: Number(t.v) }; }
		if (t.t === 'str') { p++; return { k: 'str', v: t.v }; }
		if (t.t === 'op' && t.v === '(') { p++; const e = ternary(); expect(')'); return e; }
		if (t.t === 'op' && t.v === '[') {
			p++; const items: Node[] = [];
			if (!isOp(']')) { items.push(ternary()); while (isOp(',')) { p++; items.push(ternary()); } }
			expect(']'); return { k: 'list', items };
		}
		if (t.t === 'id') {
			p++;
			if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true' };
			if (isOp('(')) return { k: 'call', fn: t.v, args: args() };
			return { k: 'id', name: t.v };
		}
		throw new Unsupported(`unexpected "${t.v}"`);
	}
	function postfix(): Node {
		let e = primary();
		for (;;) {
			if (isOp('.')) {
				p++; const name = peek(); if (name.t !== 'id') throw new Unsupported('bad method');
				p++;
				const a = isOp('(') ? args() : [];
				e = { k: 'call', fn: name.v, args: [e, ...a] };
			} else if (isOp('[')) { p++; const i = ternary(); expect(']'); e = { k: 'index', a: e, i }; } else return e;
		}
	}
	function unary(): Node {
		if (isOp('-')) { p++; return { k: 'un', op: '-', a: unary() }; }
		if (isOp('!')) { p++; return { k: 'un', op: '!', a: unary() }; }
		return power();
	}
	function power(): Node { const a = postfix(); if (isOp('^')) { p++; return { k: 'bin', op: '^', a, b: unary() }; } return a; }
	function bin(next: () => Node, ops: string[], words: Record<string, string> = {}): () => Node {
		return () => {
			let a = next();
			for (;;) {
				const t = peek();
				const op = t.t === 'op' && ops.includes(t.v) ? t.v : t.t === 'id' && words[t.v] ? words[t.v] : null;
				if (!op) return a;
				p++; a = { k: 'bin', op, a, b: next() };
			}
		};
	}
	const mul = bin(unary, ['*', '/', '%']);
	const add = bin(mul, ['+', '-']);
	const cmp = bin(add, ['>', '<', '>=', '<=']);
	const eq = bin(cmp, ['==', '!=']);
	// `not` binds looser than comparisons (not a > 3 == not (a > 3)), `!` binds tight
	function notExpr(): Node { if (isWord('not')) { p++; return { k: 'un', op: '!', a: notExpr() }; } return eq(); }
	const and = bin(notExpr, ['&&'], { and: '&&' });
	const or = bin(and, ['||'], { or: '||' });
	function ternary(): Node {
		const c = or();
		if (isOp('?')) { p++; const a = ternary(); expect(':'); const b = ternary(); return { k: 'call', fn: 'if', args: [c, a, b] }; }
		return c;
	}
	const root = ternary();
	if (peek().t !== 'eof') throw new Unsupported(`unexpected "${peek().v}"`);
	return root;
}

// ---------------------------------------------------------------- emitter
export interface PropEnv {
	/** Bases expression + kind for prop("name") in the data source being compiled. Throws Unsupported. */
	prop(name: string): Em;
}

const lit = (s: string) => JSON.stringify(s);
const em = (code: string, kind: Kind, nullable = false, atom = false): Em => ({ code, kind, nullable, atom });
const recv = (e: Em) => (e.atom ? e.code : `(${e.code})`);
const DEFAULTS: Partial<Record<Kind, string>> = { num: '0', str: '""', list: '[]', links: '[]', bool: 'false' };
/** non-null version of a value (Notion treats empty as 0 / "" / [] in most functions) */
export function coalesce(e: Em, kind: Kind = e.kind): Em {
	if (!e.nullable) return e;
	if (kind === 'bool') return em(`${recv(e)} == true`, 'bool');
	const d = DEFAULTS[kind];
	if (!d) return e;
	return em(`if(${recv(e)}.isEmpty(), ${d}, ${e.code})`, e.kind === 'any' ? kind : e.kind, false, true);
}
const asList = (e: Em): Em => (e.kind === 'list' || e.kind === 'links' ? coalesce(e) : em(`list(${coalesce(e).code})`, 'list', false, true));

const COLOR_STYLES = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
const DUR: Record<string, string> = { years: 'y', quarters: '', months: 'M', weeks: 'w', days: 'd', hours: 'h', minutes: 'm', seconds: 's', milliseconds: 'ms' };
const DUR_FIELD: Record<string, string> = { years: 'years', months: 'months', weeks: 'weeks', days: 'days', hours: 'hours', minutes: 'minutes', seconds: 'seconds', milliseconds: 'milliseconds' };

/** Functions with no Bases equivalent (from the official importer's deny list + ours). */
const UNSUPPORTED = new Set(['sqrt', 'exp', 'ln', 'log10', 'log2', 'sign', 'cbrt', 'pi', 'e', 'pow', 'match', 'median', 'mode',
	'timestamp', 'fromTimestamp', 'dateRange', 'email', 'link', 'findIndex', 'formatNumber', 'toDate']);

export class Emitter {
	private vars: Map<string, Em>[] = [];
	private env: PropEnv;
	constructor(env: PropEnv) { this.env = env; }

	emitRoot(n: Node): Em {
		// style() is only representable as the WHOLE result (html() cannot be concatenated)
		if (n.k === 'call' && n.fn === 'style') return this.style(n.args);
		if (n.k === 'call' && n.fn === 'unstyle') return this.emit(n.args[0]);
		const e = this.emit(n);
		if (e.kind === 'html') throw new Unsupported('style() inside an expression');
		return e;
	}

	private style(args: Node[]): Em {
		const text = this.emit(args[0]);
		if (text.kind === 'html') throw new Unsupported('nested style()');
		const cls: string[] = [];
		for (const a of args.slice(1)) {
			if (a.k !== 'str') throw new Unsupported('style() with computed style');
			const s = a.v;
			if (['b', 'i', 'u', 's', 'c'].includes(s)) cls.push('n-f-' + s);
			else if (s.endsWith('_background') && COLOR_STYLES.has(s.replace('_background', ''))) cls.push('n-bg-' + s.replace('_background', ''));
			else if (COLOR_STYLES.has(s)) cls.push('n-c-' + s);
		}
		return em(`html("<span class='n-style ${cls.join(' ')}'>" + escapeHTML(${this.str(text).code}) + "</span>")`, 'html', false, true);
	}

	/** value as text the way Notion's format() prints it */
	private str(e: Em): Em {
		if (e.kind === 'str') return coalesce(e);
		if (e.kind === "list" || e.kind === "links") return em(`${recv(this.listNames(coalesce(e)))}.join(",")`, 'str', false, true);
		if (e.nullable) return em(`if(${recv(e)}.isEmpty(), "", ${recv(e)}.toString())`, 'str', false, true);
		return em(`${recv(e)}.toString()`, 'str', false, true);
	}
	/** list of links → list of page names (Notion prints relation values by title) */
	private listNames(e: Em): Em { return e.kind === 'links' ? em(`${recv(e)}.map(${LINK_NAME})`, 'list', false, true) : e; }

	emit(n: Node): Em {
		switch (n.k) {
			case 'num': return em(String(n.v), 'num', false, true);
			case 'str': return em(lit(n.v), 'str', false, true);
			case 'bool': return em(String(n.v), 'bool', false, true);
			case 'list': return em(`[${n.items.map(i => this.emit(i).code).join(', ')}]`, 'list', false, true);
			case 'id': {
				for (let i = this.vars.length - 1; i >= 0; i--) { const v = this.vars[i].get(n.name); if (v) return v; }
				throw new Unsupported(`unknown identifier ${n.name}`);
			}
			case 'index': return em(`${recv(asList(this.emit(n.a)))}[${this.emit(n.i).code}]`, 'any', true, true);
			case 'un': {
				const a = this.emit(n.a);
				if (n.op === '-') return em(`-${recv(coalesce(a, 'num'))}`, 'num');
				return em(`!${recv(this.bool(a))}`, 'bool');
			}
			case 'bin': return this.binary(n.op, n.a, n.b);
			case 'call': return this.call(n.fn, n.args);
		}
	}

	private bool(e: Em): Em { return e.kind === 'bool' && !e.nullable ? e : e.kind === 'bool' ? coalesce(e) : e; }

	private binary(op: string, an: Node, bn: Node): Em {
		const a = this.emit(an), b = this.emit(bn);
		if (op === '^') throw new Unsupported('^ (power)');
		if (op === '&&' || op === '||') return em(`${this.wrapBin(this.bool(a))} ${op} ${this.wrapBin(this.bool(b))}`, 'bool');
		if (op === '==' || op === '!=') return em(`${this.wrapBin(a)} ${op} ${this.wrapBin(b)}`, 'bool');
		if (['>', '<', '>=', '<='].includes(op)) {
			const k = a.kind === 'date' || b.kind === 'date' ? 'date' : a.kind === 'str' || b.kind === 'str' ? 'str' : 'num';
			return em(`${this.wrapBin(coalesce(a, k))} ${op} ${this.wrapBin(coalesce(b, k))}`, 'bool');
		}
		if (op === '+') {
			const isStr = a.kind === 'str' || b.kind === 'str';
			if (isStr) return em(`${this.wrapBin(this.str(a))} + ${this.wrapBin(this.str(b))}`, 'str');
			if (a.kind === 'list' || b.kind === 'list' || a.kind === 'links') return em(`[${a.code}, ${b.code}].flat()`, 'list', false, true);
			return em(`${this.wrapBin(coalesce(a, 'num'))} + ${this.wrapBin(coalesce(b, 'num'))}`, a.kind === 'any' && b.kind === 'any' ? 'any' : 'num');
		}
		return em(`${this.wrapBin(coalesce(a, 'num'))} ${op} ${this.wrapBin(coalesce(b, 'num'))}`, 'num');
	}
	private wrapBin(e: Em): string { return e.atom || /^[\w."[\]]+$/.test(e.code) ? e.code : `(${e.code})`; }

	private lambda(listEm: Em, body: Node): Em {
		this.vars.push(new Map([['current', em('value', listEm.kind === 'links' ? 'any' : 'any', true, true)], ['index', em('index', 'num', false, true)]]));
		try { return this.emit(body); } finally { this.vars.pop(); }
	}

	private call(fn: string, args: Node[]): Em {
		const A = (i: number) => { if (!args[i]) throw new Unsupported(`${fn}(): missing argument`); return this.emit(args[i]); };
		const strArg = (i: number) => { const n = args[i]; if (!n || n.k !== 'str') throw new Unsupported(`${fn}() needs a literal string`); return n.v; };
		if (UNSUPPORTED.has(fn)) throw new Unsupported(`${fn}()`);
		switch (fn) {
			case 'prop': return this.env.prop(strArg(0));
			case 'if': { const c = this.bool(A(0)), a = A(1), b = A(2); return em(`if(${c.code}, ${a.code}, ${b.code})`, a.kind === 'any' ? b.kind : a.kind, a.nullable || b.nullable, true); }
			case 'ifs': {
				const parts = args.map(x => this.emit(x));
				let out = parts.length % 2 === 1 ? parts[parts.length - 1] : em('null', 'any', true, true);
				const pairs = Math.floor(parts.length / 2);
				let kind: Kind = out.kind;
				for (let i = pairs - 1; i >= 0; i--) { out = em(`if(${this.bool(parts[2 * i]).code}, ${parts[2 * i + 1].code}, ${out.code})`, kind === 'any' ? parts[2 * i + 1].kind : kind, true, true); kind = out.kind; }
				return out;
			}
			case 'and': return this.binary('&&', args[0], args[1]);
			case 'or': return this.binary('||', args[0], args[1]);
			case 'not': return em(`!${recv(this.bool(A(0)))}`, 'bool');
			case 'empty': {
				const a = A(0);
				if (a.kind === 'num') return em(`(${recv(a)}.isEmpty() || ${recv(a)} == 0)`, 'bool', false, true);
				if (a.kind === 'bool') return em(`${recv(a)} != true`, 'bool');
				return em(`${recv(a)}.isEmpty()`, 'bool', false, true);
			}
			case 'length': { const a = A(0); return em(`${recv(a.kind === 'list' || a.kind === 'links' ? coalesce(a) : coalesce(a, 'str'))}.length`, 'num', false, true); }
			case 'format': return this.str(A(0));
			case 'toNumber': return em(`number(${A(0).code})`, 'num', true, true);
			case 'contains': case 'includes': {
				const a = A(0), b = A(1);
				if (a.kind === 'list' || a.kind === 'links') return em(`${recv(this.listNames(coalesce(a)))}.contains(${b.code})`, 'bool', false, true);
				return em(`${recv(this.str(a))}.contains(${this.str(b).code})`, 'bool', false, true);
			}
			case 'lower': case 'upper': case 'trim': return em(`${recv(this.str(A(0)))}.${fn}()`, 'str', false, true);
			case 'replace': case 'replaceAll': {
				const s = this.str(A(0)); const pat = strArg(1); const rep = this.str(A(2));
				const re = '/' + pat.replace(/\//g, '\\/') + '/' + (fn === 'replaceAll' ? 'g' : '');
				return em(`${recv(s)}.replace(${re}, ${rep.code})`, 'str', false, true);
			}
			case 'test': { const s = this.str(A(0)); const pat = strArg(1); return em(`/${pat.replace(/\//g, '\\/')}/.matches(${s.code})`, 'bool', false, true); }
			case 'substring': return em(`${recv(this.str(A(0)))}.slice(${A(1).code}${args[2] ? ', ' + A(2).code : ''})`, 'str', false, true);
			case 'repeat': return em(`${recv(this.str(A(0)))}.repeat(${coalesce(A(1), 'num').code})`, 'str', false, true);
			case 'split': return em(`${recv(this.str(A(0)))}.split(${A(1).code})`, 'list', false, true);
			case 'join': return em(`${recv(this.listNames(asList(A(0))))}.join(${A(1).code})`, 'str', false, true);
			case 'concat': return em(`[${args.map(x => this.emit(x).code).join(', ')}].flat()`, 'list', false, true);
			case 'abs': case 'ceil': case 'floor': return em(`${recv(coalesce(A(0), 'num'))}.${fn}()`, 'num', false, true);
			case 'round': return em(`${recv(coalesce(A(0), 'num'))}.round(${args[1] ? A(1).code : ''})`, 'num', false, true);
			case 'add': return this.binary('+', args[0], args[1]);
			case 'subtract': return this.binary('-', args[0], args[1]);
			case 'multiply': return this.binary('*', args[0], args[1]);
			case 'divide': return this.binary('/', args[0], args[1]);
			case 'mod': return this.binary('%', args[0], args[1]);
			case 'equal': return this.binary('==', args[0], args[1]);
			case 'unequal': return this.binary('!=', args[0], args[1]);
			case 'larger': return this.binary('>', args[0], args[1]);
			case 'largerEq': return this.binary('>=', args[0], args[1]);
			case 'smaller': return this.binary('<', args[0], args[1]);
			case 'smallerEq': return this.binary('<=', args[0], args[1]);
			case 'unaryMinus': return em(`-${recv(coalesce(A(0), 'num'))}`, 'num');
			case 'sum': case 'mean': case 'average': case 'max': case 'min': {
				const flat = em(`[${args.map(x => this.emit(x).code).join(', ')}].flat().filter(value != null)`, 'list', false, true);
				if (fn === 'sum') return em(`${flat.code}.reduce(acc + value, 0)`, 'num', false, true);
				if (fn === 'max' || fn === 'min') return em(`${flat.code}.reduce(if(acc == null || value ${fn === 'max' ? '>' : '<'} acc, value, acc), null)`, 'num', true, true);
				return em(`if(${flat.code}.length == 0, null, ${flat.code}.reduce(acc + value, 0) / ${flat.code}.length)`, 'num', true, true);
			}
			case 'now': return em('now()', 'date', false, true);
			case 'today': return em('today()', 'date', false, true);
			case 'parseDate': return em(`date(${A(0).code})`, 'date', true, true);
			case 'formatDate': { const d = A(0); return em(`${recv(d)}.format(${A(1).code})`, 'str', true, true); } // date(null).format() is empty
			case 'year': case 'month': case 'hour': case 'minute': return em(`${recv(A(0))}.${fn}`, 'num', true, true);
			case 'date': return em(`${recv(A(0))}.day`, 'num', true, true);
			case 'day': return em(`number(${recv(A(0))}.format("E"))`, 'num', true, true);       // 1 = Monday … 7 = Sunday (Notion 2.0)
			case 'week': return em(`number(${recv(A(0))}.format("W"))`, 'num', true, true);
			case 'dateAdd': case 'dateSubtract': {
				const unit = DUR[strArg(2)]; if (!unit) throw new Unsupported(`${fn} unit ${strArg(2)}`);
				return em(`${recv(A(0))} ${fn === 'dateAdd' ? '+' : '-'} (${recv(coalesce(A(1), 'num'))}.toString() + "${unit}")`, 'date', true);
			}
			case 'dateBetween': {
				const f = DUR_FIELD[strArg(2)]; if (!f) throw new Unsupported(`dateBetween unit ${strArg(2)}`);
				const d = `(${A(0).code} - ${A(1).code}).${f}`;
				return em(`if(${d} < 0, ${d}.ceil(), ${d}.floor())`, 'num', false, true);   // Notion truncates toward 0
			}
			case 'dateStart': return A(0);
			case 'dateEnd': {
				const n = args[0];
				if (n?.k === 'call' && n.fn === 'prop' && n.args[0]?.k === 'str') return this.env.prop(`${n.args[0].v} (end)`);
				throw new Unsupported('dateEnd() of a computed value');
			}
			case 'id': return em('note["notion-id"].replace(/-/g, "")', 'str', false, true);
			case 'name': return A(0); // people are imported as names
			case 'let': {
				if (args[0]?.k !== 'id') throw new Unsupported('let() name');
				this.vars.push(new Map([[args[0].name, this.paren(A(1))]]));
				try { return this.emit(args[2]); } finally { this.vars.pop(); }
			}
			case 'lets': {
				const m = new Map<string, Em>(); this.vars.push(m);
				try {
					for (let i = 0; i + 1 < args.length - 1; i += 2) { const nm = args[i]; if (nm.k !== 'id') throw new Unsupported('lets() name'); m.set(nm.name, this.paren(this.emit(args[i + 1]))); }
					return this.emit(args[args.length - 1]);
				} finally { this.vars.pop(); }
			}
			case 'map': { const l = this.listNames(asList(A(0))); const b = this.lambda(l, args[1]); return em(`${recv(l)}.map(${b.code})`, 'list', false, true); }
			case 'filter': { const l = this.listNames(asList(A(0))); const b = this.lambda(l, args[1]); return em(`${recv(l)}.filter(${this.bool(b).code})`, 'list', false, true); }
			case 'some': { const l = this.listNames(asList(A(0))); const b = this.lambda(l, args[1]); return em(`${recv(l)}.filter(${this.bool(b).code}).length > 0`, 'bool'); }
			case 'every': { const l = this.listNames(asList(A(0))); const b = this.lambda(l, args[1]); return em(`${recv(l)}.filter(!${recv(this.bool(b))}).length == 0`, 'bool'); }
			case 'find': { const l = this.listNames(asList(A(0))); const b = this.lambda(l, args[1]); return em(`${recv(l)}.filter(${this.bool(b).code})[0]`, 'any', true, true); }
			case 'first': return em(`${recv(this.listNames(asList(A(0))))}[0]`, 'any', true, true);
			case 'last': { const l = this.paren(this.listNames(asList(A(0)))); return em(`${l.code}[${l.code}.length - 1]`, 'any', true, true); }
			case 'at': return em(`${recv(this.listNames(asList(A(0))))}[${A(1).code}]`, 'any', true, true);
			case 'slice': return em(`${recv(asList(A(0)))}.slice(${A(1).code}${args[2] ? ', ' + A(2).code : ''})`, 'list', false, true);
			case 'sort': case 'reverse': case 'unique': case 'flat': { const a = A(0); const l = a.kind === 'str' && fn === 'reverse' ? coalesce(a) : this.listNames(asList(a)); return em(`${recv(l)}.${fn}()`, l.kind, false, true); }
			case 'style': throw new Unsupported('style() inside an expression');
			case 'unstyle': return A(0);
		}
		throw new Unsupported(`${fn}()`);
	}
	private paren(e: Em): Em { return e.atom ? e : { ...e, code: `(${e.code})`, atom: true }; }
}

// ---------------------------------------------------------------- data-source level compile
export interface LiveProp { key: string; display?: string; expr: string; kind: Kind; displayExpr?: string }
export interface FormulaReportEntry { db: string; property: string; type: 'formula' | 'rollup'; live: boolean; reason?: string; notion: string; bases?: string }

/** Lookup for the data source a relation points to. */
export interface DsLookup { schema(dsId: string): Schema | undefined }

export function formulaKey(p: any): string {
	const ascii = String(p.name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	return ascii && /^[A-Za-z]/.test(ascii) && ascii.length <= 40 ? ascii : 'f_' + hash(String(p.id)).slice(0, 6);
}

function kindOfType(t: string): Kind {
	switch (t) {
		case 'number': return 'num';
		case 'checkbox': return 'bool';
		case 'date': case 'created_time': case 'last_edited_time': return 'date';
		case 'multi_select': case 'people': case 'files': return 'list';
		case 'relation': return 'links';
		case 'formula': case 'rollup': return 'any';
		default: return 'str';
	}
}

/** Plain-frontmatter reference to a property, as a value of the right kind. */
export function noteRef(p: any): Em {
	const r = `note[${lit(propKey(p.name))}]`;
	switch (p.type) {
		case 'title': return em('file.name', 'str', false, true);
		case 'checkbox': return em(`(${r} == true)`, 'bool', false, true);
		case 'date': case 'created_time': case 'last_edited_time': return em(`date(${r})`, 'date', true, true); // date(null) is null in Bases
		default: return em(r, kindOfType(p.type), true, true);
	}
}

/** Bases: keep only relation items that are links to existing notes (URLs / missing pages can't be dereferenced). */
export const FILE_ITEMS = '.filter(value.isType("link")).filter(value.asFile())';
/** Display name of a relation item: the note name for links, the text itself for kept Notion URLs. */
export const LINK_NAME = 'if(value.isType("link") && value.asFile(), value.asFile().name, value.toString())';

const PCT = new Set(['percent_checked', 'percent_unchecked', 'percent_empty', 'percent_not_empty', 'percent_per_group']);

/** Rollup → Bases expression over the linked notes. */
function rollupExpr(p: any, schema: Schema, look: DsLookup): { code: string; kind: Kind } {
	const r = p.rollup || {};
	const rel = schema.byId.get(r.relation_property_id) || schema.byId.get(decodeURIComponent(r.relation_property_id || '')) || schema.byName.get(r.relation_property_name);
	if (!rel || rel.type !== 'relation') throw new Unsupported('rollup relation not found');
	const tds = look.schema(rel.relation?.data_source_id || rel.relation?.database_id || '');
	const tp = tds ? (tds.byId.get(r.rollup_property_id) || tds.byId.get(decodeURIComponent(r.rollup_property_id || '')) || tds.byName.get(r.rollup_property_name)) : { name: r.rollup_property_name, type: 'unknown' };
	if (!tp) throw new Unsupported(`rollup target ${r.rollup_property_name} not found`);
	if (tp.type === 'formula' || tp.type === 'rollup') throw new Unsupported(`rollup of a ${tp.type} property (computed in the other database)`);
	if (tp.type === 'button') throw new Unsupported('rollup of a button');
	const relCode = `note[${lit(propKey(rel.name))}]`;
	const all = `if(${relCode}.isEmpty(), [], list(${relCode}))`;
	// Relations to pages outside the import are kept as https://www.notion.so/<id> URLs (backup, D10); asFile() on a
	// URL throws in Bases ("Cannot find function asFile on type URL"), so only real links are dereferenced.
	const items = `${all}${FILE_ITEMS}`;
	const tkind = kindOfType(tp.type);
	let V: string;
	if (tp.type === 'title') V = 'value.asFile().name';
	else if (tp.type === 'relation') V = `if(value.asFile().properties[${lit(propKey(tp.name))}].isEmpty(), [], list(value.asFile().properties[${lit(propKey(tp.name))}])).map(${LINK_NAME})`;
	else V = `value.asFile().properties[${lit(propKey(tp.name))}]`;
	const isList = tkind === 'list' || tkind === 'links';
	const vals = `${items}.map(${V})${isList ? '.flat()' : ''}`;
	const nonEmpty = `${vals}.filter(value != null && value != "")`;
	const n = `${items}.length`;
	const pct = (cond: string) => `if(${n} == 0, null, ${items}.filter(${cond}).length / ${n})`;
	const asDate = (s: string) => `${s}.map(date(value))`;
	switch (r.function) {
		case 'show_original': return { code: vals, kind: 'list' };
		case 'show_unique': return { code: `${vals}.unique()`, kind: 'list' };
		case 'count': case 'count_all': return { code: `${all}.length`, kind: 'num' }; // Notion counts every related page, imported or not
		case 'count_values': return { code: `${nonEmpty}.length`, kind: 'num' };
		case 'unique': case 'count_unique_values': return { code: `${nonEmpty}.unique().length`, kind: 'num' };
		case 'empty': case 'count_empty': return { code: `${items}.filter(${V}.isEmpty()).length`, kind: 'num' };
		case 'not_empty': case 'count_not_empty': return { code: `${items}.filter(!${V}.isEmpty()).length`, kind: 'num' };
		case 'percent_empty': return { code: pct(`${V}.isEmpty()`), kind: 'num' };
		case 'percent_not_empty': return { code: pct(`!${V}.isEmpty()`), kind: 'num' };
		case 'checked': return { code: `${items}.filter(${V} == true).length`, kind: 'num' };
		case 'unchecked': return { code: `${items}.filter(${V} != true).length`, kind: 'num' };
		case 'percent_checked': return { code: pct(`${V} == true`), kind: 'num' };
		case 'percent_unchecked': return { code: pct(`${V} != true`), kind: 'num' };
		case 'sum': return { code: `${nonEmpty}.reduce(acc + number(value), 0)`, kind: 'num' };
		case 'average': return { code: `if(${nonEmpty}.length == 0, null, ${nonEmpty}.reduce(acc + number(value), 0) / ${nonEmpty}.length)`, kind: 'num' };
		case 'min': return { code: `${nonEmpty}.reduce(if(acc == null || number(value) < acc, number(value), acc), null)`, kind: 'num' };
		case 'max': return { code: `${nonEmpty}.reduce(if(acc == null || number(value) > acc, number(value), acc), null)`, kind: 'num' };
		case 'range': return { code: `${nonEmpty}.reduce(if(acc == null || number(value) > acc, number(value), acc), null) - ${nonEmpty}.reduce(if(acc == null || number(value) < acc, number(value), acc), null)`, kind: 'num' };
		case 'earliest_date': return { code: `${asDate(nonEmpty)}.reduce(if(acc == null || value < acc, value, acc), null)`, kind: 'date' };
		case 'latest_date': return { code: `${asDate(nonEmpty)}.reduce(if(acc == null || value > acc, value, acc), null)`, kind: 'date' };
		default: throw new Unsupported(`rollup function ${r.function}`);
	}
}

export function notionExpression(p: any, schema: Schema): string {
	let e: string = p.formula?.expression || '';
	// API 2025-09+ placeholders → prop("Name")
	e = e.replace(/\{\{notion:block_property:([^:}]+):[^}]*\}\}/g, (m, id) => {
		const q = schema.byId.get(id) || schema.byId.get(decodeURIComponent(id));
		return q ? `prop(${lit(q.name)})` : m;
	});
	return e;
}

/**
 * Compile every formula/rollup property of one data source.
 * Returns the live ones (key + Bases expression) and a report line for every property.
 */
export function compileFormulas(dbName: string, schema: Schema, look: DsLookup, opts: { forceStatic?: Set<string> } = {}): { live: Map<string, LiveProp>; report: FormulaReportEntry[] } {
	const live = new Map<string, LiveProp>();
	const report: FormulaReportEntry[] = [];
	const state = new Map<string, 'busy' | 'live' | 'static'>();
	const used = new Set<string>();
	const keyOf = new Map<string, string>();
	for (const p of schema.ordered) if (p.type === 'formula' || p.type === 'rollup') {
		let k = formulaKey(p); while (used.has(k)) k = k + '_'; used.add(k); keyOf.set(p.name, k);
	}

	const compile = (p: any): void => {
		if (state.has(p.name)) return;
		state.set(p.name, 'busy');
		const entry: FormulaReportEntry = { db: dbName, property: p.name, type: p.type, live: false, notion: p.type === 'formula' ? notionExpression(p, schema) : `rollup ${p.rollup?.function}(${p.rollup?.relation_property_name} → ${p.rollup?.rollup_property_name})` };
		try {
			if (opts.forceStatic?.has(p.name)) throw new Unsupported('value is read by a chart/calendar block (kept static)');
			let code: string; let kind: Kind;
			if (p.type === 'rollup') ({ code, kind } = rollupExpr(p, schema, look));
			else {
				const env: PropEnv = {
					prop: (name: string) => {
						const q = schema.byName.get(name);
						if (!q) {
							const base = name.endsWith(' (end)') ? schema.byName.get(name.slice(0, -6)) : null;
							if (base?.type === 'date') return em(`date(note[${lit(propKey(name))}])`, 'date', true, true);
							throw new Unsupported(`unknown property ${name}`);
						}
						if (q.type === 'formula' || q.type === 'rollup') {
							compile(q);
							const st = state.get(q.name);
							if (st === 'busy') throw new Unsupported(`circular reference via ${name}`);
							const lp = live.get(q.name);
							if (lp) return em(`formula.${lp.key}`, lp.kind, true, true);
							return em(`note[${lit(propKey(q.name))}]`, 'any', true, true); // static fallback value
						}
						if (q.type === 'button') throw new Unsupported('button property');
						return noteRef(q);
					},
				};
				const e = new Emitter(env).emitRoot(parseFormula(entry.notion));
				code = e.code; kind = e.kind;
			}
			const lp: LiveProp = { key: keyOf.get(p.name)!, expr: code, kind };
			if (p.type === 'rollup' && PCT.has(p.rollup?.function)) {
				lp.display = lp.key + '_pct';
				lp.displayExpr = `if(formula.${lp.key} == null, "", (formula.${lp.key} * 100).round() + "%")`;
			}
			live.set(p.name, lp);
			state.set(p.name, 'live');
			entry.live = true; entry.bases = code;
		} catch (err) {
			if (!(err instanceof Unsupported)) throw err;
			state.set(p.name, 'static');
			entry.reason = err.message;
		}
		report.push(entry);
	};
	for (const p of schema.ordered) if (p.type === 'formula' || p.type === 'rollup') compile(p);
	// a live formula that reads a static one is still marked live, but say so in the report
	for (const e of report) if (e.live && e.bases && /note\["/.test(e.bases)) {
		const staticDeps = report.filter(x => !x.live && e.bases!.includes(`note[${lit(propKey(x.property))}]`)).map(x => x.property);
		if (staticDeps.length) e.reason = `live, but reads static value(s) of ${staticDeps.join(', ')}`;
	}
	return { live, report };
}

/** Markdown section for the import report. */
export function formulaReportMarkdown(entries: FormulaReportEntry[]): string {
	if (!entries.length) return '';
	const live = entries.filter(e => e.live).length;
	const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	const lines = [`## 公式 / 汇总 (Formulas & rollups)`, '', `${live} / ${entries.length} 转成实时 Bases 公式（写在 .base 的 formulas: 里，笔记里不再存静态值）；其余保留 Notion 导入时的静态值。`, '',
		'| 数据库 | 属性 | 类型 | 结果 | 说明 |', '| --- | --- | --- | --- | --- |'];
	for (const e of entries) lines.push(`| ${esc(e.db)} | ${esc(e.property)} | ${e.type} | ${e.live ? '实时 live' : '静态 static'} | ${esc(e.reason || '')} |`);
	const st = entries.filter(e => !e.live);
	if (st.length) {
		lines.push('', '### 静态回退的 Notion 原公式', '');
		for (const e of st) lines.push(`- **${e.db} › ${e.property}**: \`${e.notion.replace(/`/g, "'")}\` — ${e.reason}`);
	}
	return lines.join('\n') + '\n';
}
