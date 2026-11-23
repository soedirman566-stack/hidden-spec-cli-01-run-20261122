// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats — a unified diff,
// SEARCH/REPLACE blocks, a V4A patch or JSON edits — finds the lines each edit names at the first of three matching
// tiers (exact, then trailing-whitespace-blind, then fully whitespace-blind), applies every edit or none, and
// prints exactly what SPEC.md says: one line per changed path and an `ok:` line, or one line per failed edit and a
// `failed:` line, or a single `error:` line at exit 2. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old path, new path], for the `R` output lines. */
  readonly moves: [string, string][] = [];
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

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, and whether its text ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  fin: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    lines.pop();
  }
  return { lines, br, fin };
}

function writeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

/** Section 5 matching: tiers compare lines exactly, then without trailing, then without surrounding blanks. */
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function eqAt(tier: number, a: string, b: string): boolean {
  return tier === 0 ? a === b : tier === 1 ? trimTrail(a) === trimTrail(b) : trimBoth(a) === trimBoth(b);
}

/** Every position at or after `from` where O occurs at `tier`; with `eofEnd`, only occurrences ending at the last line. */
function occurrences(lines: string[], O: string[], tier: number, from: number, eofEnd: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    if (eofEnd && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!eqAt(tier, lines[i + j]!, O[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, and its positions there; null when O occurs at no tier. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, eofEnd = false): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrences(lines, O, tier, from, eofEnd);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: a context line, an old line, a new line, or a `\` no-newline marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** True when the patch line itself was empty (an empty context line), which matters at a body's end. */
  rawEmpty: boolean;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** At tier 2 a new line is re-indented: its copy of O's first line's indent P becomes the file's own, F. */
function reindent(line: string, F: string, P: string): string {
  if (line.trim() === '') return line;
  if (P === '') return F + line;
  return line.startsWith(P) ? F + line.slice(P.length) : line;
}

/**
 * Replace the `olen` file lines at `pos` by walking the body: context lines are written as the file's own matched
 * lines, `-` lines are dropped, `+` lines are written (re-indented at tier 2). A body of only `+` lines (a
 * SEARCH/REPLACE block's new lines) still consumes all `olen` old lines. Returns the new line array.
 */
function applyBody(lines: string[], pos: number, olen: number, body: BodyLine[], tier: number, O: string[]): string[] {
  const F = leadWs(lines[pos] ?? '');
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const out: string[] = [];
  let fi = pos;
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(lines[fi]!);
      fi += 1;
    } else if (b.kind === '-') {
      fi += 1;
    } else if (b.kind === '+') {
      out.push(tier === 2 ? reindent(b.text, F, P) : b.text);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + olen)];
}

/** True when a `\` line follows the body's last context or `+` line (so the result has no final line break). */
function backslashAfterLastNew(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') return body[i + 1]?.kind === '\\';
  }
  return false;
}

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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

/* ---------------- Unified diffs (section 6) ---------------- */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  oldP: string | null;
  newP: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names: up to the first tab, spaces removed, `/dev/null` kept, a/ or b/ stripped. */
function headerPath(raw: string): string {
  let t = raw;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t !== '/dev/null' && (t.startsWith('a/') || t.startsWith('b/'))) t = t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
      hunk = null;
    }
  };
  const newSection = (): Section => {
    closeHunk();
    const s: Section = { gitOld: null, gitNew: null, oldP: null, newP: null, renFrom: null, renTo: null, newFile: false, delFile: false, hasPair: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const L = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (L.startsWith('diff --git ')) {
      const m = GIT_RE.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      continue;
    }
    if (L.startsWith('--- ') && next.startsWith('+++ ')) {
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0 && hunk === null) {
        cur.oldP = headerPath(L.slice(4));
        cur.newP = headerPath(next.slice(4));
        cur.hasPair = true;
      } else {
        const s = newSection();
        s.oldP = headerPath(L.slice(4));
        s.newP = headerPath(next.slice(4));
        s.hasPair = true;
      }
      i += 1;
      continue;
    }
    if (L.startsWith('@@')) {
      const m = HUNK_RE.exec(L);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      continue;
    }
    const inHeader = cur !== null && cur.hunks.length === 0 && hunk === null;
    if (inHeader && L.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (hunk !== null && (L === '' || L[0] === ' ' || L[0] === '-' || L[0] === '+' || L[0] === '\\')) {
      hunk.body.push({ kind: L === '' ? ' ' : (L[0] as BodyLine['kind']), text: L === '' ? '' : L.slice(1), rawEmpty: L === '' });
      continue;
    }
    closeHunk();
    if (inHeader && cur !== null) {
      if (L.startsWith('rename from ')) cur.renFrom = L.slice(12);
      else if (L.startsWith('rename to ')) cur.renTo = L.slice(10);
      else if (L.startsWith('new file mode')) cur.newFile = true;
      else if (L.startsWith('deleted file mode')) cur.delFile = true;
    }
    // Any other line outside a body is ignored (prose, code fences, index lines, a stray `+++`).
  }
  closeHunk();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.oldP ?? sec.renFrom ?? sec.gitOld!;
    const newPath = sec.newP ?? sec.renTo ?? sec.gitNew!;
    const creation = oldPath === '/dev/null' || sec.newFile;
    const deletion = !creation && (newPath === '/dev/null' || sec.delFile);
    // Every real path the section names is checked for safety before anything else (section 10).
    if (oldPath !== '/dev/null') checkSafe(oldPath);
    if (newPath !== '/dev/null' && newPath !== oldPath) checkSafe(newPath);
    if (creation) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') out.push(b.text);
      // The final-break rule for a creation reads the `\` after its last `+` line overall.
      let fin = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi -= 1) {
          if (body[bi]!.kind === '+') {
            fin = body[bi + 1]?.kind !== '\\';
            break outer;
          }
        }
      }
      tree.now.set(newPath, writeFile({ lines: out, br: '\n', fin }));
      return;
    }
    if (deletion) {
      checkSafe(oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    checkSafe(oldPath);
    if (newPath !== oldPath) checkSafe(newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (newPath !== oldPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O = h.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
      const N = h.body.filter((b) => b.kind === ' ' || b.kind === '+').map((b) => b.text);
      if (O.length === 0) {
        const plus = h.body.filter((b) => b.kind === '+').map((b) => b.text);
        const atEnd = h.a + d >= model.lines.length;
        const pos = Math.min(h.a + d, model.lines.length);
        model.lines.splice(pos, 0, ...plus);
        if (atEnd) model.fin = !backslashAfterLastNew(h.body);
        d += plus.length;
        continue;
      }
      const found = findTier(model.lines, O, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const runsToEnd = pos + O.length === model.lines.length;
      model.lines = applyBody(model.lines, pos, O.length, h.body, found.tier, O);
      if (runsToEnd) model.fin = !backslashAfterLastNew(h.body);
      d += N.length - O.length;
    }
    const text = writeFile(model);
    if (newPath !== oldPath) {
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

/* ---------------- SEARCH/REPLACE blocks (section 7) ---------------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeFile({ lines: [...newLines], br: '\n', fin: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLine[] = newLines.map((t) => ({ kind: '+', text: t, rawEmpty: false }));
    model.lines = applyBody(model.lines, found.positions[0]!, oldLines.length, body, found.tier, oldLines);
    tree.now.set(path, writeFile(model));
  };
}

/* ---------------- V4A patches (section 8) ---------------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aHeader(L: string): { type: 'add' | 'delete' | 'update'; path: string } | null {
  if (L.startsWith('*** Add File:')) return { type: 'add', path: L.slice(13).trim() };
  if (L.startsWith('*** Delete File:')) return { type: 'delete', path: L.slice(16).trim() };
  if (L.startsWith('*** Update File:')) return { type: 'update', path: L.slice(16).trim() };
  return null;
}

const isEofLine = (L: string): boolean => L === '*** End of File' || (L.startsWith('*** End of File') && L.slice(15).trim() === '');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i])) {
      lastNB = i;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const L = lines[i]!;
    if (blank(L)) {
      i += 1;
      continue;
    }
    const hdr = v4aHeader(L);
    if (hdr === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const body: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < lastNB && v4aHeader(lines[j]!) === null) {
      body.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it (section 8; blank as section 4 defines it).
    while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();
    edits.push(v4aEdit(hdr, body, headerLine, strict));
    i = j;
  }
  return edits;
}

function v4aEdit(hdr: { type: 'add' | 'delete' | 'update'; path: string }, body: { text: string; no: number }[], headerLine: number, strict: boolean): Edit {
  const path = hdr.path;
  if (hdr.type === 'add') {
    const content: string[] = [];
    for (const b of body) {
      if (b.text.startsWith('+')) content.push(b.text.slice(1));
      else if (b.text === '') content.push('');
      else throw new Exit2(`error: parse ${b.no}`);
    }
    return (tree) => {
      checkSafe(path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeFile({ lines: content, br: '\n', fin: true }));
    };
  }
  if (hdr.type === 'delete') {
    if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
    return (tree) => {
      checkSafe(path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update File: an optional `*** Move to:` first line, then chunks.
  let moveTo: string | null = null;
  let start = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
    moveTo = body[0]!.text.slice(12).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = start; k < body.length; k += 1) {
    const b = body[k]!;
    if (b.text.startsWith('@@')) {
      cur = { anchor: b.text.slice(2).trim() || null, eof: false, body: [] };
      chunks.push(cur);
    } else if (isEofLine(b.text)) {
      if (cur !== null) {
        cur.eof = true;
        cur = null;
      } else if (chunks.length === 0) {
        chunks.push({ anchor: null, eof: true, body: [] });
      } else {
        throw new Exit2(`error: parse ${b.no}`);
      }
    } else if (b.text === '' || b.text[0] === ' ' || b.text[0] === '-' || b.text[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${b.no}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ kind: b.text === '' ? ' ' : (b.text[0] as BodyLine['kind']), text: b.text === '' ? '' : b.text.slice(1), rawEmpty: b.text === '' });
    } else {
      throw new Exit2(`error: parse ${b.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    checkSafe(path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      checkSafe(moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (eqAt(tier, model.lines[k]!, ch.anchor)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const O = ch.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
      const N = ch.body.filter((b) => b.kind === ' ' || b.kind === '+').map((b) => b.text);
      if (O.length === 0) {
        const plus = ch.body.filter((b) => b.kind === '+').map((b) => b.text);
        const pos = ch.eof ? model.lines.length : cursor;
        model.lines.splice(pos, 0, ...plus);
        cursor = pos + plus.length;
        continue;
      }
      const found = findTier(model.lines, O, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      model.lines = applyBody(model.lines, pos, O.length, ch.body, found.tier, O);
      cursor = pos + N.length;
    }
    const text = writeFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/* ---------------- The run (sections 1, 2 and 10) ---------------- */

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      suppressed.add(o);
      suppressed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!suppressed.has(p)) rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
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
