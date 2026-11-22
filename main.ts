// mend: one patch tool for every AI edit format.
//
// Written fresh from SPEC.md (version 1) in the kit's starter. Node 22 and its
// standard library alone; run as `node main.ts [options] [PATCH]` with the
// working directory as the root of a tree of text files. It reads a patch in
// one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and
// writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A patch that cannot be read in its format; `line` is the 1-based patch line. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit that failed; reported as `error: <code> <path>`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const blank = (s: string): boolean => s.trim() === '';

/** SPEC section 3: a patch's lines are its text split at \n, each with one trailing \r removed. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a path is safe when it is not empty, does not start with /, holds no \ ... */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** SPEC section 3: a file's lines, its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitText(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function joinText(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private origCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

// ---------------------------------------------------------------------------
// SPEC section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** All 0-based positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j] as string, lines[i + j] as string, tier)) {
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

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs. */
function firstTierWith(O: string[], lines: string[], from: number, strict: boolean): TierHit | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a hunk or chunk body: context, old, new, or a backslash line. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Split a body into its old lines O and its new lines N (context lines flagged). */
function splitBody(body: BodyItem[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx });
      oIdx += 1;
    } else if (b.kind === 'old') {
      o.push(b.text);
      oIdx += 1;
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Render N as it is written: context lines as the file's own matched lines, and at tier 2
 *  every other line re-indented (F = leading ws of the file's first matched line, P = leading
 *  ws of O's first line; a non-blank line starting with P has that P replaced by F). */
function renderN(n: NewLine[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  const P = leadingWs(o[0] as string);
  const F = leadingWs(fileLines[at] as string);
  return n.map((it) => {
    if (it.ctx) return fileLines[at + it.oIdx] as string;
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return it.text;
  });
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLastCtxOrPlus(body: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === 'bs';
}

// ---------------------------------------------------------------------------
// Edits. An edit names its paths (checked for safety before anything else
// about it), and applies itself to the tree, throwing EditFail on failure.
// ---------------------------------------------------------------------------

interface Edit {
  paths: string[];
  move?: { old: string; new: string };
  apply: (tree: Tree) => void;
}

/** A line that is a created file's content: LF breaks, ending with one unless empty. */
function createdContent(lines: string[]): string {
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// SPEC section 4: detecting the format.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// SPEC section 6: unified diffs.
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  a: number;
  body: BodyItem[];
}

interface UnifiedSection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hasDashPair: boolean;
  inHeader: boolean;
  hunks: UnifiedHunk[];
}

function newUnifiedSection(): UnifiedSection {
  return {
    dashOld: undefined,
    dashNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFileMode: false,
    deletedFileMode: false,
    hasDashPair: false,
    inHeader: true,
    hunks: [],
  };
}

/** The path a `--- ` or `+++ ` line names: text after the four characters, up to the first
 *  tab, surrounding spaces removed; /dev/null means no file; a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function pickPath(a: string | null | undefined, b: string | undefined, c: string | undefined): string | null {
  if (a !== undefined) return a;
  if (b !== undefined) return b;
  if (c !== undefined) return c;
  return null;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let hunk: UnifiedHunk | null = null;

  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && blank(hunk.body[hunk.body.length - 1]!.text) && hunk.body[hunk.body.length - 1]!.kind === 'ctx') {
        hunk.body.pop();
      }
      sec.hunks.push(hunk);
      hunk = null;
    }
  };
  const endSection = (): void => {
    endHunk();
    if (sec !== null) {
      sections.push(sec);
      sec = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (hunk !== null) {
      if (
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))
      ) {
        endHunk();
        // fall through: this line starts something new
      } else if (
        line === '' ||
        line[0] === ' ' ||
        line[0] === '-' ||
        line[0] === '+' ||
        line[0] === '\\'
      ) {
        const kind = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'bs';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
        continue;
      } else {
        endHunk();
        // fall through: prose ends the body
      }
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      endSection();
      sec = newUnifiedSection();
      sec.diffOld = m[1] as string;
      sec.diffNew = m[2] as string;
      continue;
    }

    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(lines[i + 1] as string);
        if (sec !== null && sec.inHeader && !sec.hasDashPair) {
          sec.dashOld = oldP;
          sec.dashNew = newP;
          sec.hasDashPair = true;
        } else {
          endSection();
          sec = newUnifiedSection();
          sec.dashOld = oldP;
          sec.dashNew = newP;
          sec.hasDashPair = true;
        }
        i += 1;
        continue;
      }
      if (sec !== null && sec.inHeader) throw new ParseFault(i + 2);
      continue;
    }

    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      if (sec === null) throw new ParseFault(i + 1);
      sec.inHeader = false;
      hunk = { a: parseInt(m[1] as string, 10), body: [] };
      continue;
    }

    if (sec !== null && sec.inHeader) {
      if (line.startsWith('rename from ')) {
        if (sec.renameOld === undefined) sec.renameOld = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (sec.renameNew === undefined) sec.renameNew = line.slice(10).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFileMode = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFileMode = true;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any
      // other line in a header are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
  }
  endSection();
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply one unified hunk to a file state; `d` is the length delta of this section's hunks
 *  applied so far. Throws EditFail('no-match', path) when O is not found. */
function applyUnifiedHunk(state: FileState, h: UnifiedHunk, d: number, strict: boolean, path: string): FileState {
  const { o, n } = splitBody(h.body);
  if (o.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), state.lines.length);
    const ins = n.map((it) => it.text);
    const lines = [...state.lines.slice(0, pos), ...ins, ...state.lines.slice(pos)];
    let finalBreak = state.finalBreak;
    if (pos === state.lines.length) {
      finalBreak = !backslashAfterLastCtxOrPlus(h.body);
    }
    return { lines, br: state.br, finalBreak };
  }
  const found = firstTierWith(o, state.lines, 0, strict);
  if (found === null) throw new EditFail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.occ[0] as number;
  let best = Math.abs(at - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      at = p;
      best = dist;
    }
  }
  const repl = renderN(n, o, state.lines, at, found.tier);
  const lines = [...state.lines.slice(0, at), ...repl, ...state.lines.slice(at + o.length)];
  let finalBreak = state.finalBreak;
  if (at + o.length === state.lines.length) {
    finalBreak = !backslashAfterLastCtxOrPlus(h.body);
  }
  return { lines, br: state.br, finalBreak };
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  const oldPath = pickPath(sec.dashOld, sec.renameOld, sec.diffOld);
  const newPath = pickPath(sec.dashNew, sec.renameNew, sec.diffNew);
  const isCreate = sec.newFileMode || oldPath === null;
  const isDelete = !isCreate && (sec.deletedFileMode || newPath === null);
  const isMove =
    !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;

  const paths: string[] = [];
  if (isCreate) {
    if (newPath !== null) paths.push(newPath);
  } else if (isDelete) {
    if (oldPath !== null) paths.push(oldPath);
  } else if (isMove) {
    if (oldPath !== null) paths.push(oldPath);
    if (newPath !== null) paths.push(newPath);
  } else if (oldPath !== null) {
    paths.push(oldPath);
  }

  const edit: Edit = {
    paths,
    apply(tree: Tree): void {
      if (isCreate) {
        if (newPath === null) throw new EditFail('missing', '');
        if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
        const plus: string[] = [];
        let lastPlus: { hunk: UnifiedHunk; idx: number } | null = null;
        for (const h of sec.hunks) {
          h.body.forEach((b, idx) => {
            if (b.kind === 'new') {
              plus.push(b.text);
              lastPlus = { hunk: h, idx };
            }
          });
        }
        let finalBreak = true;
        if (lastPlus !== null) {
          const next = (lastPlus as { hunk: UnifiedHunk; idx: number }).hunk.body[
            (lastPlus as { hunk: UnifiedHunk; idx: number }).idx + 1
          ];
          if (next !== undefined && next.kind === 'bs') finalBreak = false;
        }
        tree.now.set(
          newPath,
          plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''),
        );
        return;
      }
      if (isDelete) {
        if (oldPath === null) throw new EditFail('missing', '');
        if (tree.get(oldPath) === null) throw new EditFail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      const src = oldPath as string;
      const cur = tree.get(src);
      if (cur === null) throw new EditFail('missing', src);
      if (isMove && tree.get(newPath as string) !== null) {
        throw new EditFail('exists', newPath as string);
      }
      let state = splitText(cur);
      let d = 0;
      for (const h of sec.hunks) {
        const { o, n } = splitBody(h.body);
        state = applyUnifiedHunk(state, h, d, strict, src);
        d += n.length - o.length;
      }
      const content = joinText(state.lines, state.br, state.finalBreak);
      if (isMove) {
        tree.now.set(src, null);
        tree.now.set(newPath as string, content);
      } else {
        tree.now.set(src, content);
      }
    },
  };
  if (isMove) edit.move = { old: oldPath as string, new: newPath as string };
  return edit;
}

// ---------------------------------------------------------------------------
// SPEC section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j] as string;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(sIdx + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if ((lines[j] as string).trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseFault(sIdx + 1);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFault(sIdx + 1);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    paths: [path],
    apply(tree: Tree): void {
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.now.set(path, createdContent(newLines));
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new EditFail('missing', path);
      const state = splitText(cur);
      const found = firstTierWith(oldLines, state.lines, 0, strict);
      if (found === null) throw new EditFail('no-match', path);
      if (found.occ.length > 1) throw new EditFail('ambiguous', path);
      const at = found.occ[0] as number;
      const P = leadingWs(oldLines[0] as string);
      const F = leadingWs(state.lines[at] as string);
      const repl = newLines.map((t) => {
        if (found.tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) {
          return F + t.slice(P.length);
        }
        return t;
      });
      const lines = [
        ...state.lines.slice(0, at),
        ...repl,
        ...state.lines.slice(at + oldLines.length),
      ];
      tree.now.set(path, joinText(lines, state.br, state.finalBreak));
    },
  };
}

// ---------------------------------------------------------------------------
// SPEC section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string;
  eof: boolean;
  body: BodyItem[];
}

interface V4aSectionLine {
  text: string;
  num: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseFault(1);
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i] as string)) {
      last = i;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(line);
    if (m === null) throw new ParseFault(i + 1);
    const kind = m[1] as string;
    const path = (m[2] as string).trim();
    const updateLine = i + 1;
    const secLines: V4aSectionLine[] = [];
    i += 1;
    while (i < last) {
      const l = lines[i] as string;
      if (/^\*\*\* (Add|Delete|Update) File: /.test(l)) break;
      secLines.push({ text: l, num: i + 1 });
      i += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    edits.push(v4aSectionEdit(kind, path, secLines, updateLine, strict));
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function v4aSectionEdit(
  kind: string,
  path: string,
  secLines: V4aSectionLine[],
  updateLine: number,
  strict: boolean,
): Edit {
  if (kind === 'Add') {
    const fileLines: string[] = [];
    for (const { text, num } of secLines) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new ParseFault(num);
    }
    return {
      paths: [path],
      apply(tree: Tree): void {
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.now.set(path, createdContent(fileLines));
      },
    };
  }

  if (kind === 'Delete') {
    for (const { num } of secLines) throw new ParseFault(num);
    return {
      paths: [path],
      apply(tree: Tree): void {
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.now.set(path, null);
      },
    };
  }

  // Update: an optional `*** Move to:` first, then chunks.
  let moveTo: string | null = null;
  let idx = 0;
  while (idx < secLines.length && blank(secLines[idx]!.text)) idx += 1;
  if (idx < secLines.length && (secLines[idx] as V4aSectionLine).text.startsWith('*** Move to: ')) {
    moveTo = (secLines[idx] as V4aSectionLine).text.slice('*** Move to: '.length).trim();
    idx += 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = idx; k < secLines.length; k++) {
    const { text, num } = secLines[k] as V4aSectionLine;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new ParseFault(num);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (blank(text)) {
      if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
      continue;
    }
    if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseFault(num);
        cur = { anchor: '', eof: false, body: [] };
      }
      const bk = text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'old' : 'new';
      cur.body.push({ kind: bk, text: text.slice(1) });
      continue;
    }
    throw new ParseFault(num);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine);

  const paths: string[] = [path];
  if (moveTo !== null) paths.push(moveTo);
  const edit: Edit = {
    paths,
    apply(tree: Tree): void {
      const curText = tree.get(path);
      if (curText === null) throw new EditFail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
      let state = splitText(curText);
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== '') {
          const foundAnchor = firstTierWith([chunk.anchor], state.lines, cursor, strict);
          if (foundAnchor === null) throw new EditFail('no-match', path);
          cursor = (foundAnchor.occ[0] as number) + 1;
        }
        const { o, n } = splitBody(chunk.body);
        if (o.length === 0) {
          const pos = chunk.eof ? state.lines.length : cursor;
          const ins = n.map((it) => it.text);
          const lines = [...state.lines.slice(0, pos), ...ins, ...state.lines.slice(pos)];
          state = { lines, br: state.br, finalBreak: state.finalBreak };
          cursor = pos + ins.length;
          continue;
        }
        const found = firstTierWith(o, state.lines, cursor, strict);
        if (found === null) throw new EditFail('no-match', path);
        let at: number;
        if (chunk.eof) {
          at = -1;
          for (const p of found.occ) {
            if (p + o.length === state.lines.length) {
              at = p;
              break;
            }
          }
          if (at < 0) throw new EditFail('no-match', path);
        } else {
          at = found.occ[0] as number;
        }
        const repl = renderN(n, o, state.lines, at, found.tier);
        const lines = [...state.lines.slice(0, at), ...repl, ...state.lines.slice(at + o.length)];
        state = { lines, br: state.br, finalBreak: state.finalBreak };
        cursor = at + repl.length;
      }
      const content = joinText(state.lines, state.br, state.finalBreak);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, content);
      } else {
        tree.now.set(path, content);
      }
    },
  };
  if (moveTo !== null) edit.move = { old: path, new: moveTo };
  return edit;
}

// ---------------------------------------------------------------------------
// SPEC section 9: JSON edits.
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path as string;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text as string;
    return {
      paths: [p],
      apply(tree: Tree): void {
        if (tree.get(p) !== null) throw new EditFail('exists', p);
        tree.now.set(p, text);
      },
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str as string;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      paths: [p],
      apply(tree: Tree): void {
        const cur = tree.get(p);
        if (cur === null) throw new EditFail('missing', p);
        const nl = cur.indexOf('\n');
        const crlf = nl > 0 && cur[nl - 1] === '\r';
        const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = norm(cur);
        const old = norm(oldStr);
        const nw = norm(newStr);
        let count = 0;
        let at = -1;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
          count += 1;
          if (at < 0) at = k;
        }
        if (count === 0) throw new EditFail('no-match', p);
        if (count > 1) throw new EditFail('ambiguous', p);
        const out = t.slice(0, at) + nw + t.slice(at + old.length);
        tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line as number;
    const add = patchLines(o.new_str as string);
    return {
      paths: [p],
      apply(tree: Tree): void {
        const cur = tree.get(p);
        if (cur === null) throw new EditFail('missing', p);
        const state = splitText(cur);
        if (line < 0 || line > state.lines.length) throw new EditFail('no-match', p);
        const lines = [...state.lines.slice(0, line), ...add, ...state.lines.slice(line)];
        tree.now.set(p, joinText(lines, state.br, state.finalBreak));
      },
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFault(1);
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
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------------------
// SPEC sections 1, 2 and 10: invocation, output, order and atomicity.
// ---------------------------------------------------------------------------

function usageResult(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usageResult();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usageResult();
        format = v;
      } else if (a === '--check') {
        if (check) return usageResult();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageResult();
        strict = true;
      } else {
        return usageResult();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usageResult();
  const patchArg = pos.length === 0 ? null : (pos[0] as string);

  let text = '';
  try {
    text = readFileSync(patchArg === null || patchArg === '-' ? 0 : patchArg, 'utf8');
  } catch {
    if (patchArg !== null && patchArg !== '-') return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      for (const p of edit.paths) {
        if (!safe(p)) throw new EditFail('unsafe', p);
      }
      edit.apply(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  // Exit 0: one line per changed path, in byte order; a move prints `R old -> new`
  // (sorting by the new path) instead of its D and A lines.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const edit of edits) {
    if (edit.move === undefined) continue;
    const m = edit.move;
    const oldOrig = tree.original(m.old);
    const oldFinal = tree.get(m.old);
    const newOrig = tree.original(m.new);
    const newFinal = tree.get(m.new);
    if (oldOrig !== null && oldFinal === null && newOrig === null && newFinal !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${tag} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!check) {
    for (const [p, v] of tree.now) {
      if (v === null) rmSync(p, { force: true });
    }
    for (const [p, v] of tree.now) {
      if (v !== null && v !== tree.original(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one,
  // without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  // The CLI: one run, one stdout write at the end, so an unexpected failure
  // can never leave partial output behind (stderr is never compared).
  let r;
  try {
    r = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`mend: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
  if (r !== undefined) {
    writeSync(1, r.out.map((l) => `${l}\n`).join(''));
    process.exitCode = r.code;
  }
}
