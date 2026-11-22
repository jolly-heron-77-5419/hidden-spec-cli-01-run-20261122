// mend: one patch tool for every AI edit format, to SPEC.md version 1 (MIT).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
// Reads unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A
// patches and JSON tool calls, finds the lines each edit names at the first
// of three matching tiers, and changes every file or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit, run against the tree as earlier edits left it. A move edit reports its pair on success. */
type EditResult = { move?: [string, string] } | void;
type Edit = (tree: Tree) => EditResult;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Files: lines, line break, final break (SPEC section 3) ----

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

// ---- Matching lines at three tiers (SPEC section 5) ----

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const NORMS: Array<(s: string) => string> = [(s) => s, trimEndWs, trimBothWs];

/** 0-based positions at or after `from` where O matches the file's lines at `tier`. */
function tierOccurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const norm = NORMS[tier]!;
  const want = o.map(norm);
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (norm(lines[i + k]!) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = tierOccurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One line of N: a context line (written as the file's own matched line) or an added line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Render N for a match at `at` with tier `tier`: context lines come from the file, added lines are
 *  re-indented at tier 2 (SPEC section 5) and written as they are at tiers 0 and 1. */
function renderN(nLines: NLine[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2) {
    return nLines.map((nl) => (nl.ctx ? fileLines[at + nl.oIdx]! : nl.text));
  }
  const p = leadingWs(o[0]!);
  const f = leadingWs(fileLines[at]!);
  return nLines.map((nl) => {
    if (nl.ctx) return fileLines[at + nl.oIdx]!;
    const t = nl.text;
    if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** A hunk/chunk body as operations: context, deleted and added lines. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

function opsToON(ops: Op[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      n.push({ text: op.text, ctx: true, oIdx: o.length });
      o.push(op.text);
    } else if (op.kind === 'del') {
      o.push(op.text);
    } else {
      n.push({ text: op.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Replace the matched lines at `at` with N, rendered for `tier`. */
function applyReplace(st: FileState, o: string[], n: NLine[], at: number, tier: number): void {
  const rendered = renderN(n, o, st.lines, at, tier);
  st.lines.splice(at, o.length, ...rendered);
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastAddNoEol: boolean;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function patchPath(line: string): string {
  const rest = line.slice(4);
  const cut = rest.split('\t', 1)[0]!;
  return cut.trim();
}

/** `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function toPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hasPair = false;
  const n = lines.length;
  const newSection = (): Section => {
    const s: Section = {
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      createFlag: false,
      delFlag: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    hasPair = false;
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        // The body ends at a `--- ` line followed by a `+++ ` line: that pair starts a new
        // section, even though the `--- ` line on its own would look like a `-` body line.
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const ops: Op[] = [];
      for (const bl of body) {
        if (bl === '') ops.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') ops.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') ops.push({ kind: 'del', text: bl.slice(1) });
        else if (bl[0] === '+') ops.push({ kind: 'add', text: bl.slice(1) });
      }
      let noEol = false;
      let lastAddNoEol = false;
      let lastCtxAdd = -1;
      let lastAdd = -1;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b === '' || b[0] === ' ' || b[0] === '+') lastCtxAdd = k;
        if (b !== '' && b[0] === '+') lastAdd = k;
      }
      if (lastCtxAdd >= 0 && lastCtxAdd + 1 < body.length && body[lastCtxAdd + 1]![0] === '\\') noEol = true;
      if (lastAdd >= 0 && lastAdd + 1 < body.length && body[lastAdd + 1]![0] === '\\') lastAddNoEol = true;
      cur.hunks.push({ a, ops, noEol, lastAddNoEol });
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = i + 1 < n ? lines[i + 1]! : null;
      const followed = next !== null && next.startsWith('+++ ');
      if (cur !== null && cur.hunks.length === 0) {
        // Inside a section's header: a `--- ` line must be followed by a `+++ ` line.
        if (!followed) throw new Exit2(`error: parse ${i + 2}`);
        if (!hasPair) {
          cur.pairOld = toPath(patchPath(line));
          cur.pairNew = toPath(patchPath(next!));
          hasPair = true;
          i += 2;
          continue;
        }
      }
      if (followed) {
        const s = newSection();
        s.pairOld = toPath(patchPath(line));
        s.pairNew = toPath(patchPath(next!));
        hasPair = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.createFlag = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.delFlag = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== null ? s.renameFrom : s.diffOld;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renameTo !== null ? s.renameTo : s.diffNew;
  return { oldP, newP };
}

function sectionKind(sec: Section, oldP: string | null, newP: string | null): 'create' | 'delete' | 'move' | 'change' | 'noop' {
  if (oldP === null && newP === null) return 'noop';
  if (oldP === null) return 'create';
  if (newP === null) return 'delete';
  if (sec.createFlag) return 'create';
  if (sec.delFlag) return 'delete';
  if (oldP !== newP) return 'move';
  return 'change';
}

/** The file a creation holds: the `+` lines of all its hunks, in order, LF, ended by a line break
 *  unless a `\` line follows its last `+` line. */
function creationContent(hunks: Hunk[]): string {
  const lines: string[] = [];
  for (const h of hunks) for (const op of h.ops) if (op.kind === 'add') lines.push(op.text);
  if (lines.length === 0) return '';
  let noEol = false;
  for (let k = hunks.length - 1; k >= 0; k--) {
    const h = hunks[k]!;
    if (h.ops.some((op) => op.kind === 'add')) {
      noEol = h.lastAddNoEol;
      break;
    }
  }
  return lines.join('\n') + (noEol ? '' : '\n');
}

/** Apply a section's hunks in order to a file's text. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = opsToON(h.ops);
    if (o.length === 0) {
      const at = Math.min(h.a + d, st.lines.length);
      const atEnd = at === st.lines.length;
      st.lines.splice(at, 0, ...n.map((nl) => nl.text));
      if (atEnd) st.final = !h.noEol;
    } else {
      const found = findTier(st.lines, o, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === st.lines.length;
      applyReplace(st, o, n, best, found.tier);
      if (runsToEnd) st.final = !h.noEol;
    }
    d += n.length - o.length;
  }
  return joinFile(st);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const { oldP, newP } = sectionPaths(sec);
  const kind = sectionKind(sec, oldP, newP);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (kind === 'noop') return undefined;
    if (kind === 'create') {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, creationContent(sec.hunks));
      return undefined;
    }
    if (kind === 'delete') {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return undefined;
    }
    if (kind === 'move') {
      const op = oldP!;
      const np = newP!;
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, applyUnifiedHunks(cur, sec.hunks, strict, op));
      tree.now.set(op, null);
      return { move: [op, np] };
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(cur, sec.hunks, strict, p));
    return undefined;
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SREdit {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let end = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, end);
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = prevPath;
      }
      prevPath = path;
      edits.push({ path, oldLines, newLines });
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  return edits;
}

function srEdit(e: SREdit, strict: boolean): Edit {
  return (tree) => {
    if (!safe(e.path)) throw new Fail('unsafe', e.path);
    if (e.oldLines.length === 0) {
      if (tree.get(e.path) !== null) throw new Fail('exists', e.path);
      tree.now.set(e.path, e.newLines.length === 0 ? '' : e.newLines.join('\n') + '\n');
      return undefined;
    }
    const cur = tree.get(e.path);
    if (cur === null) throw new Fail('missing', e.path);
    const st = splitFile(cur);
    const found = findTier(st.lines, e.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', e.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', e.path);
    const pos = found.occ[0]!;
    const nLines: NLine[] = e.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rendered = renderN(nLines, e.oldLines, st.lines, pos, found.tier);
    st.lines.splice(pos, e.oldLines.length, ...rendered);
    tree.now.set(e.path, joinFile(st));
    return undefined;
  };
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: VChunk[];
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < end && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind: 'add', path, moveTo: null, fileLines, chunks: [] });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < end && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      for (const r of raw) throw new Exit2(`error: parse ${r.idx + 1}`);
      sections.push({ kind: 'delete', path, moveTo: null, fileLines: [], chunks: [] });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateIdx = i;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: { text: string; idx: number }[] = [];
      while (i < end && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (const r of raw) {
        const t = r.text;
        if (t === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, ops: [] };
          else cur.eof = true;
          flush();
          continue;
        }
        if (t.startsWith('@@')) {
          flush();
          const atext = t.slice(2).trim();
          cur = { anchor: atext === '' ? null : atext, eof: false, ops: [] };
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, ops: [] };
          if (t === '') cur.ops.push({ kind: 'ctx', text: '' });
          else if (t[0] === ' ') cur.ops.push({ kind: 'ctx', text: t.slice(1) });
          else if (t[0] === '-') cur.ops.push({ kind: 'del', text: t.slice(1) });
          else cur.ops.push({ kind: 'add', text: t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      sections.push({ kind: 'update', path, moveTo, fileLines: [], chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const norm = NORMS[t]!;
    const want = norm(anchor);
    for (let k = from; k < lines.length; k++) {
      if (norm(lines[k]!) === want) return k;
    }
  }
  return null;
}

function applyV4aChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  const st = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const at = findAnchor(st.lines, ch.anchor, strict, cursor);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { o, n } = opsToON(ch.ops);
    if (o.length === 0) {
      const at = ch.eof ? st.lines.length : cursor;
      st.lines.splice(at, 0, ...n.map((nl) => nl.text));
      cursor = at + n.length;
    } else {
      const found = findTier(st.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos: number;
      if (ch.eof) {
        const want = st.lines.length - o.length;
        if (!found.occ.includes(want)) throw new Fail('no-match', path);
        pos = want;
      } else {
        pos = found.occ[0]!;
      }
      applyReplace(st, o, n, pos, found.tier);
      cursor = pos + n.length;
    }
  }
  return joinFile(st);
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      return undefined;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return undefined;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const out = applyV4aChunks(cur, sec.chunks, strict, sec.path);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      return { move: [sec.path, sec.moveTo] };
    }
    tree.now.set(sec.path, out);
    return undefined;
  };
}

// ---- Running the CLI (SPEC sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((e) => srEdit(e, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const res = edit(tree);
      if (res !== undefined && res.move !== undefined) moves.push(res.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    text: string;
    path: string;
    kind: 'A' | 'D' | 'M' | 'R';
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, kind: was === null ? 'A' : now === null ? 'D' : 'M' });
  }
  for (const [oldP, newP] of moves) {
    const di = rows.findIndex((r) => r.kind === 'D' && r.path === oldP);
    const ai = rows.findIndex((r) => r.kind === 'A' && r.path === newP);
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}`, path: newP, kind: 'R' });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    // Delete first, deepest first, so a file can take the place of a directory that held one
    // (and a directory can take the place of a file that was deleted); then write the rest.
    const delPaths = [...tree.now.keys()]
      .filter((p) => tree.now.get(p) === null)
      .sort((a, b) => b.split('/').length - a.split('/').length || Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    for (const p of delPaths) rmSync(p, { force: true });
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
