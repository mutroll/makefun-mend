// Adversarial tests for mend, written from SPEC.md (not from the practice set).
// Each case hand-computes the expected exit code, stdout and final files.
// Run: node tests/adversarial.mjs   (from the entry directory)
// Exits non-zero if any case fails. Every case runs twice; the two runs must
// be byte-identical (determinism).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (statSync(p).isFile()) out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-adv-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], {
      cwd: dir,
      input: c.stdin ?? '',
      encoding: 'utf8',
      timeout: 10000,
    });
    return { exit: r.status, stdout: r.stdout ?? '', files: readTree(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Start files plus changes (null: deleted) -> the full expected final tree. */
function after(files, changes) {
  const out = { ...files };
  for (const [p, v] of Object.entries(changes)) {
    if (v === null) delete out[p];
    else out[p] = v;
  }
  return out;
}

const cases = [];
const add = (name, argv, stdin, files, expect) => cases.push({ name, argv, stdin, files, expect });

// ---------------------------------------------------------------------------
// Section 1/2: invocation, usage errors, exit 2 order.
// ---------------------------------------------------------------------------
add('cli: unknown option', ['--bogus', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: --check twice', ['--check', '--check', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: --strict twice', ['--strict', '--strict', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: --format twice', ['--format=json', '--format=json', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: bad --format value', ['--format=git', 'p.diff'], null, { 'p.diff': 'x\n' }, { exit: 2, stdout: 'error: usage\n', files: { 'p.diff': 'x\n' } });
add('cli: empty --format value', ['--format=', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: bare --format', ['--format', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: two positionals', ['a.patch', 'b.patch'], null, {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: short option', ['-x', '-'], '', {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: -- ends options, positional --check is a file', ['--', '--check'], null, {}, { exit: 2, stdout: 'error: no-patch\n', files: {} });
add('cli: two positionals after --', ['--', 'a', 'b'], null, {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: usage wins over no-patch', ['--bogus', 'missing.patch'], null, {}, { exit: 2, stdout: 'error: usage\n', files: {} });
add('cli: no-patch wins over format', ['missing.patch'], null, {}, { exit: 2, stdout: 'error: no-patch\n', files: {} });
add('cli: empty patch, --format=unified', ['--format=unified'], '', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: empty patch, --format=json', ['--format=json'], '', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: empty patch, --format=v4a', ['--format=v4a'], '', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: empty patch, --format=search-replace', ['--format=search-replace'], '', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: empty patch, auto', [], '', {}, { exit: 2, stdout: 'error: format\n', files: {} });
add('cli: --format=v4a, first line not Begin', ['--format=v4a'], 'hello\n', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: --format=v4a, first non-blank line 3', ['--format=v4a'], '\n\nhello\n', {}, { exit: 2, stdout: 'error: parse 3\n', files: {} });
add('cli: --format=search-replace, no SEARCH', ['--format=search-replace'], 'foo\nbar\n', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: --format=unified on json text', ['--format=unified'], '{"a":1}\n', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: --format=json on unified text', ['--format=json'], '--- a/x\n+++ b/x\n', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('cli: --format=auto explicit', ['--format=auto', '-'], 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', { 'f.txt': 'a\n' }, { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'A\n' } });
add('cli: options after positional, --check', ['p.txt', '--check'], null,
  { 'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'p.txt': 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' } });
add('cli: patch file is a directory', ['somedir'], null, { 'somedir/x': 'y\n' }, { exit: 2, stdout: 'error: no-patch\n', files: { 'somedir/x': 'y\n' } });

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------
add('u: backslash after + line, no final break', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n b\n-c\n+C\n\\ No newline at end of file\n',
  { 'f.txt': 'a\nb\nc' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\nC' } });
add('u: backslash after context line, no final break', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n',
  { 'f.txt': 'a\nb\nc' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nB\nc' } });
add('u: backslash after - line only, final break stays', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -2,2 +2,1 @@\n b\n-c\n\\ No newline at end of file\n',
  { 'f.txt': 'a\nb\nc' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\n' } });
add('u: no backslash, matched to end, final break added', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n b\n-c\n+C\n',
  { 'f.txt': 'a\nb\nc' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\nC\n' } });
add('u: hunk not at end, final break untouched', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n',
  { 'f.txt': 'a\nb\nc' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'A\nb\nc' } });
add('u: create, backslash after last + line', ['-'],
  '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n',
  {},
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': 'hello\nworld' } });
add('u: create, no + lines, empty file', ['-'],
  '--- /dev/null\n+++ b/empty.txt\n@@ -0,0 +1,0 @@\n',
  {},
  { exit: 0, stdout: 'A empty.txt\nok: 1 file\n', files: { 'empty.txt': '' } });
add('u: delete, hunks not read', ['-'],
  '--- a/gone.txt\n+++ /dev/null\n@@ -1,3 +1,0 @@\n-nonexistent line here\n',
  { 'gone.txt': 'a\nb\nc\n' },
  { exit: 0, stdout: 'D gone.txt\nok: 1 file\n', files: {} });
add('u: move to existing path', ['-'],
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'a.txt': 'x\n', 'b.txt': 'y\n' },
  { exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'x\n', 'b.txt': 'y\n' } });
add('u: move from missing path', ['-'],
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'b.txt': 'y\n' },
  { exit: 1, stdout: 'error: missing a.txt\nfailed: 1 of 1 edits\n', files: { 'b.txt': 'y\n' } });
add('u: rename from/to names paths, diff --git ignored', ['-'],
  'diff --git a/wrong.txt b/wrong2.txt\nrename from real.txt\nrename to real2.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'real.txt': 'x\n' },
  { exit: 0, stdout: 'R real.txt -> real2.txt\nok: 1 file\n', files: { 'real2.txt': 'y\n' } });
add('u: diff --git paths as fallback', ['-'],
  'diff --git a/f.txt b/f.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('u: malformed diff --git', ['-'],
  'diff --git a/x\n@@ -1 +1 @@\n-x\n+y\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('u: hunk before any section', ['-'],
  '@@ -1 +1 @@\n-x\n+y\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n',
  { 'x': 'x\n' },
  { exit: 2, stdout: 'error: parse 1\n', files: { 'x': 'x\n' } });
add('u: malformed @@ line', ['-'],
  '--- a/x\n+++ b/x\n@@ -1 +1 @\n-x\n+y\n',
  { 'x': 'x\n' },
  { exit: 2, stdout: 'error: parse 3\n', files: { 'x': 'x\n' } });
add('u: @@ with missing minus', ['-'],
  '--- a/x\n+++ b/x\n@@ 1,2 +3,4 @@\n-x\n+y\n',
  { 'x': 'x\n' },
  { exit: 2, stdout: 'error: parse 3\n', files: { 'x': 'x\n' } });
add('u: lone --- in header, parse at next line', ['-'],
  'diff --git a/x b/x\n--- a/x\nindex abc\n@@ -1 +1 @@\n-x\n+y\n',
  { 'x': 'x\n' },
  { exit: 2, stdout: 'error: parse 3\n', files: { 'x': 'x\n' } });
add('u: two sections, both succeed, sorted rows', ['-'],
  '--- b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n--- a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'a.txt': 'x\n', 'b.txt': 'x\n' },
  { exit: 0, stdout: 'M a.txt\nM b.txt\nok: 2 files\n', files: { 'a.txt': 'y\n', 'b.txt': 'y\n' } });
add('u: nearest with drift d', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,0 +2,1 @@\n+NEW\n@@ -4,1 +4,1 @@\n-dup\n+DUP\n',
  { 'f.txt': 'line1\ndup\nline3\ndup\nline5\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'line1\nNEW\ndup\nline3\nDUP\nline5\n' } });
add('u: nearest tie goes earlier', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -3,1 +3,1 @@\n-dup\n+DUP\n',
  { 'f.txt': 'x\ndup\ny\ndup\nz\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'x\nDUP\ny\ndup\nz\n' } });
add('u: empty-O insert at end with backslash', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -2,0 +3,1 @@\n+c\n\\ No newline at end of file\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\nc' } });
add('u: empty-O insert in middle, final break untouched', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,0 +2,1 @@\n+X\n',
  { 'f.txt': 'a\nb' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nX\nb' } });
add('u: empty-O insert at top, A=0', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+TOP\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'TOP\na\nb\n' } });
add('u: insert into empty file', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+hello\n',
  { 'f.txt': '' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'hello\n' } });
add('u: section with no hunks, file exists, no-op', ['-'],
  '--- a/f.txt\n+++ b/f.txt\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'ok: 0 files\n', files: { 'f.txt': 'x\n' } });
add('u: section with no hunks, file missing', ['-'],
  '--- a/f.txt\n+++ b/f.txt\n',
  {},
  { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', files: {} });
add('u: header path cut at tab', ['-'],
  '--- a/f.txt\t2024-01-01 00:00:00\n+++ b/f.txt\t2024-01-01\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('u: hunk counts ignored, body defines O/N', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,99 +1,99 @@\n-x\n+y\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('u: context line written as file line at tier 1', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
  { 'f.txt': 'keep  \nold\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'keep  \nnew\n' } });
add('u: CRLF file, hunk to end, CRLF kept', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  { 'f.txt': 'a\r\nb\r\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\r\nB\r\n' } });
add('u: file of one empty line', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-\n+x\n',
  { 'f.txt': '\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'x\n' } });
add('u: hunk fails, section changes nothing, other section also unwritten', ['-'],
  '--- a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n--- b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-nope\n+y\n',
  { 'a.txt': 'x\n', 'b.txt': 'x\n' },
  { exit: 1, stdout: 'error: no-match b.txt\nfailed: 1 of 2 edits\n', files: { 'a.txt': 'x\n', 'b.txt': 'x\n' } });
add('u: second hunk fails, first hunk undone', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n@@ -2,1 +2,1 @@\n-nope\n+B\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'a\nb\n' } });
add('u: prose and fences around diff', ['-'],
  'Here is the fix:\n\n```diff\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n```\n\nDone.\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('u: unsafe path after a/ strip', ['-'],
  '--- a/../x\n+++ b/../x\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'x': 'x\n' },
  { exit: 1, stdout: 'error: unsafe ../x\nfailed: 1 of 1 edits\n', files: { 'x': 'x\n' } });
add('u: create exists', ['-'],
  '--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+new\n',
  { 'f.txt': 'old\n' },
  { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'old\n' } });
add('u: delete missing', ['-'],
  '--- a/f.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-x\n',
  {},
  { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', files: {} });

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------
add('s: second block reuses previous path', ['-'],
  'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'A\nB\n' } });
add('s: first block with no path', ['-'],
  '<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  { 'f.txt': 'a\n' },
  { exit: 2, stdout: 'error: parse 1\n', files: { 'f.txt': 'a\n' } });
add('s: SEARCH with no =======', ['-'],
  'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n',
  { 'f.txt': 'a\n' },
  { exit: 2, stdout: 'error: parse 2\n', files: { 'f.txt': 'a\n' } });
add('s: SEARCH with ======= but no >>>>>>>', ['-'],
  'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n',
  { 'f.txt': 'a\n' },
  { exit: 2, stdout: 'error: parse 2\n', files: { 'f.txt': 'a\n' } });
add('s: markers with trailing whitespace', ['-'],
  'f.txt\n<<<<<<< SEARCH   \na\n=======  \nA\n>>>>>>> REPLACE\t\n',
  { 'f.txt': 'a\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'A\n' } });
add('s: empty old and empty new creates empty file', ['-'],
  'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n',
  {},
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': '' } });
add('s: empty old, file exists', ['-'],
  'f.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n',
  { 'f.txt': 'old\n' },
  { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'old\n' } });
add('s: ambiguous at tier 1', ['-'],
  'f.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  { 'f.txt': 'x \nx \n' },
  { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'x \nx \n' } });
add('s: tier 2 match with re-indent, P empty', ['-'],
  'f.txt\n<<<<<<< SEARCH\nhello\n=======\n  hello!\nworld\n>>>>>>> REPLACE\n',
  { 'f.txt': '  hello\n  world\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': '    hello!\n  world\n  world\n' } });
add('s: path line with surrounding spaces trimmed', ['-'],
  '  my file.txt  \n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  { 'my file.txt': 'a\n' },
  { exit: 0, stdout: 'M my file.txt\nok: 1 file\n', files: { 'my file.txt': 'A\n' } });
add('s: file without final break keeps none', ['-'],
  'f.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  { 'f.txt': 'a\nb' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nB' } });
add('s: CRLF file keeps CRLF', ['-'],
  'f.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  { 'f.txt': 'a\r\nb\r\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\r\nB\r\n' } });
add('s: fence line skipped for path', ['-'],
  'f.txt\n```js\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n```\n',
  { 'f.txt': 'a\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'A\n' } });

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------
add('v: missing End Patch', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n x\n-x\n+y\n',
  { 'f.txt': 'x\n' },
  { exit: 2, stdout: 'error: parse 6\n', files: { 'f.txt': 'x\n' } });
add('v: first line not Begin Patch', ['--format=v4a'],
  'hello\n*** Begin Patch\n*** End Patch\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('v: only blank lines', ['--format=v4a'], '\n\n', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('v: Add, trailing blank stripped', ['--format=v4a'],
  '*** Begin Patch\n*** Add File: n.txt\n+line1\n+line2\n\n*** End Patch\n',
  {},
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', files: { 'n.txt': 'line1\nline2\n' } });
add('v: Add to existing path', ['--format=v4a'],
  '*** Begin Patch\n*** Add File: f.txt\n+new\n*** End Patch\n',
  { 'f.txt': 'old\n' },
  { exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'old\n' } });
add('v: Delete missing', ['--format=v4a'],
  '*** Begin Patch\n*** Delete File: f.txt\n*** End Patch\n',
  {},
  { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', files: {} });
add('v: Update with no chunk and no Move to', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 2, stdout: 'error: parse 2\n', files: { 'f.txt': 'x\n' } });
add('v: Move to only, file moved unchanged', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
  { 'a.txt': 'x\n' },
  { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'b.txt': 'x\n' } });
add('v: Move to existing path', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
  { 'a.txt': 'x\n', 'b.txt': 'y\n' },
  { exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'x\n', 'b.txt': 'y\n' } });
add('v: anchor not found', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@ nope\n x\n-x\n+y\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'x\n' } });
add('v: anchor matched at tier 1', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@ target\n x\n-x\n+y\n*** End Patch\n',
  { 'f.txt': 'target \nx\nx\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'target \nx\ny\n' } });
add('v: cursor forces later occurrence', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n@@\n a\n-b\n+B2\n*** End Patch\n',
  { 'f.txt': 'a\nb\na\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nB\na\nB2\n' } });
add('v: EOF chunk, occurrence not at end', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n-b\n+B\n*** End of File\n*** End Patch\n',
  { 'f.txt': 'a\nb\nc\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'a\nb\nc\n' } });
add('v: EOF chunk, occurrence at end', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n-c\n+C\n*** End of File\n*** End Patch\n',
  { 'f.txt': 'a\nb\nc\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\nC\n' } });
add('v: EOF chunk, empty O inserts at end', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n+tail\n*** End of File\n*** End Patch\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\ntail\n' } });
add('v: empty O inserts at cursor after anchor', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@ b\n+INSERT\n*** End Patch\n',
  { 'f.txt': 'a\nb\nc\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\nINSERT\nc\n' } });
add('v: bad line in Add section', ['--format=v4a'],
  '*** Begin Patch\n*** Add File: n.txt\n+ok\n bad\n*** End Patch\n',
  {},
  { exit: 2, stdout: 'error: parse 4\n', files: {} });
add('v: line in Delete section', ['--format=v4a'],
  '*** Begin Patch\n*** Delete File: f.txt\n+x\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 2, stdout: 'error: parse 3\n', files: { 'f.txt': 'x\n' } });
add('v: End of File with no chunk', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n*** End of File\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 2, stdout: 'error: parse 3\n', files: { 'f.txt': 'x\n' } });
add('v: body line after End of File without @@', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@ a\n x\n-x\n+y\n*** End of File\n z\n*** End Patch\n',
  { 'f.txt': 'a\nx\nz\n' },
  { exit: 2, stdout: 'error: parse 8\n', files: { 'f.txt': 'a\nx\nz\n' } });
add('v: empty anchor means no anchor', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@\n-x\n+y\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('v: Move to not first', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@\n x\n-x\n+y\n*** Move to: g.txt\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 2, stdout: 'error: parse 7\n', files: { 'f.txt': 'x\n' } });
add('v: blank lines between sections ignored', ['--format=v4a'],
  '*** Begin Patch\n\n\n*** Add File: n.txt\n+hi\n\n\n*** Delete File: f.txt\n\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'D f.txt\nA n.txt\nok: 2 files\n', files: { 'n.txt': 'hi\n' } });
add('v: blank line after Update File is not a chunk line', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n \n-x\n+y\n*** End Patch\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('v: CRLF file keeps CRLF', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n-b\n+B\n*** End Patch\n',
  { 'f.txt': 'a\r\nb\r\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\r\nB\r\n' } });
add('v: anchor before cursor is not found', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n-a\n+A\n@@ a\n-b\n+B\n*** End Patch\n',
  { 'f.txt': 'a\nb\nc\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'a\nb\nc\n' } });
add('v: Update missing file', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n-x\n+y\n*** End Patch\n',
  {},
  { exit: 1, stdout: 'error: missing f.txt\nfailed: 1 of 1 edits\n', files: {} });
add('v: Add path with surrounding spaces', ['--format=v4a'],
  '*** Begin Patch\n*** Add File:   n.txt  \n+x\n*** End Patch\n',
  {},
  { exit: 0, stdout: 'A n.txt\nok: 1 file\n', files: { 'n.txt': 'x\n' } });

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------
add('j: array with trailing garbage', ['--format=json'],
  '[{"command":"create","path":"a.txt","file_text":"x"}] garbage\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: array with bad element', ['--format=json'],
  '[{"command":"bogus","path":"a.txt"}]\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: empty array', ['--format=json'], '[]\n', {}, { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: array starting on line 3', ['--format=json'],
  '\n\n[{"command":"bogus","path":"a.txt"}]\n',
  {},
  { exit: 2, stdout: 'error: parse 3\n', files: {} });
add('j: JSONL blank lines ignored', ['--format=json'],
  '\n{"command":"create","path":"a.txt","file_text":"x"}\n\n',
  {},
  { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { 'a.txt': 'x' } });
add('j: JSONL line that is not an object', ['--format=json'],
  '{"command":"create","path":"a.txt","file_text":"x"}\n42\n',
  {},
  { exit: 2, stdout: 'error: parse 2\n', files: {} });
add('j: wrong command', ['--format=json'],
  '{"command":"delete","path":"a.txt"}\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: missing path key', ['--format=json'],
  '{"command":"create","file_text":"x"}\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: str_replace without new_str replaces with empty', ['--format=json'],
  '{"command":"str_replace","path":"f.txt","old_str":"world"}\n',
  { 'f.txt': 'hello world\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'hello \n' } });
add('j: str_replace empty old_str is a parse fault', ['--format=json'],
  '{"command":"str_replace","path":"f.txt","old_str":"","new_str":"x"}\n',
  { 'f.txt': 'hello\n' },
  { exit: 2, stdout: 'error: parse 1\n', files: { 'f.txt': 'hello\n' } });
add('j: insert_line as string is a parse fault', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":"3","new_str":"x"}\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 2, stdout: 'error: parse 1\n', files: { 'f.txt': 'a\nb\n' } });
add('j: insert_line 1.5 is a parse fault', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":1.5,"new_str":"x"}\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 2, stdout: 'error: parse 1\n', files: { 'f.txt': 'a\nb\n' } });
add('j: insert_line negative is no-match', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":-1,"new_str":"x"}\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'a\nb\n' } });
add('j: insert_line at end appends', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":2,"new_str":"NEW"}\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nb\nNEW\n' } });
add('j: insert into empty file at line 0', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":0,"new_str":"x\\ny"}\n',
  { 'f.txt': '' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'x\ny' } });
add('j: insert new_str with CRLF splits lines', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":1,"new_str":"p\\r\\nq\\r\\n"}\n',
  { 'f.txt': 'a\nb\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\np\nq\nb\n' } });
add('j: create writes file_text byte for byte', ['--format=json'],
  '{"command":"create","path":"a.txt","file_text":"x\\r\\ny\\r\\n"}\n',
  {},
  { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { 'a.txt': 'x\r\ny\r\n' } });
add('j: str_replace overlapping occurrences is ambiguous', ['--format=json'],
  '{"command":"str_replace","path":"f.txt","old_str":"aa","new_str":"b"}\n',
  { 'f.txt': 'aaa\n' },
  { exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'aaa\n' } });
add('j: str_replace on CRLF file, old_str with LF', ['--format=json'],
  '{"command":"str_replace","path":"f.txt","old_str":"a\\nb","new_str":"X"}\n',
  { 'f.txt': 'a\r\nb\r\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'X\r\n' } });
add('j: extra keys ignored', ['--format=json'],
  '{"command":"create","path":"a.txt","file_text":"x","zzz":1}\n',
  {},
  { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { 'a.txt': 'x' } });
add('j: single object is JSONL with one edit', ['--format=json'],
  '{"command":"create","path":"a.txt","file_text":"x"}',
  {},
  { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { 'a.txt': 'x' } });
add('j: multi-line object in JSONL is a parse fault', ['--format=json'],
  '{\n"command":"create","path":"a.txt","file_text":"x"\n}\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: create with missing file_text is a parse fault', ['--format=json'],
  '{"command":"create","path":"a.txt"}\n',
  {},
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('j: insert at end of CRLF file keeps CRLF', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":2,"new_str":"c"}\n',
  { 'f.txt': 'a\r\nb\r\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\r\nb\r\nc\r\n' } });
add('j: insert_line beyond end is no-match', ['--format=json'],
  '{"command":"insert","path":"f.txt","insert_line":3,"new_str":"c"}\n',
  { 'f.txt': 'a\r\nb\r\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'a\r\nb\r\n' } });

// ---------------------------------------------------------------------------
// Section 10: order, atomicity, unsafe paths, output rows.
// ---------------------------------------------------------------------------
add('o: create then modify same file', ['--format=json'],
  '[{"command":"create","path":"f.txt","file_text":"hello world\\n"},{"command":"str_replace","path":"f.txt","old_str":"world","new_str":"there"}]\n',
  {},
  { exit: 0, stdout: 'A f.txt\nok: 1 file\n', files: { 'f.txt': 'hello there\n' } });
add('o: delete then create same path is a change', ['-'],
  '--- a/f.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-old\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+new\n',
  { 'f.txt': 'old\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'new\n' } });
add('o: delete then create identical content is no change', ['-'],
  '--- a/f.txt\n+++ /dev/null\n@@ -1,1 +1,0 @@\n-old\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1,1 @@\n+old\n',
  { 'f.txt': 'old\n' },
  { exit: 0, stdout: 'ok: 0 files\n', files: { 'f.txt': 'old\n' } });
add('o: move then modify new path', ['-'],
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n--- b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-y\n+z\n',
  { 'a.txt': 'x\n' },
  { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'b.txt': 'z\n' } });
add('o: second edit fails, first undone', ['--format=json'],
  '[{"command":"create","path":"a.txt","file_text":"x"},{"command":"str_replace","path":"gone.txt","old_str":"x","new_str":"y"}]\n',
  {},
  { exit: 1, stdout: 'error: missing gone.txt\nfailed: 1 of 2 edits\n', files: {} });
add('o: R row sorts by new path, after M', ['-'],
  '--- a/a.txt\n+++ b/z.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n--- m.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'a.txt': 'x\n', 'm.txt': 'x\n' },
  { exit: 0, stdout: 'M m.txt\nR a.txt -> z.txt\nok: 2 files\n', files: { 'm.txt': 'y\n', 'z.txt': 'y\n' } });
add('o: R row sorts by new path, before M', ['-'],
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n--- c.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { 'a.txt': 'x\n', 'c.txt': 'x\n' },
  { exit: 0, stdout: 'R a.txt -> b.txt\nM c.txt\nok: 2 files\n', files: { 'b.txt': 'y\n', 'c.txt': 'y\n' } });
add('o: move with unchanged content still prints R', ['-'],
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n x\n',
  { 'a.txt': 'x\n' },
  { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'b.txt': 'x\n' } });
add('o: --check failure writes nothing', ['--check', '-'],
  'f.txt\n<<<<<<< SEARCH\nnope\n=======\ny\n>>>>>>> REPLACE\n',
  { 'f.txt': 'x\n' },
  { exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', files: { 'f.txt': 'x\n' } });
add('o: no-change patch prints only ok', ['-'],
  'f.txt\n<<<<<<< SEARCH\nx\n=======\nx\n>>>>>>> REPLACE\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'ok: 0 files\n', files: { 'f.txt': 'x\n' } });
add('x: unsafe ../x (json)', ['--format=json'],
  '{"command":"create","path":"../x","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe ../x\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe /abs (json)', ['--format=json'],
  '{"command":"create","path":"/abs","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe /abs\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe a//b (json)', ['--format=json'],
  '{"command":"create","path":"a//b","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe a//b\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe a/./b (json)', ['--format=json'],
  '{"command":"create","path":"a/./b","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe a/./b\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe a/../b (json)', ['--format=json'],
  '{"command":"create","path":"a/../b","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe a/../b\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe empty path (json)', ['--format=json'],
  '{"command":"create","path":"","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe \nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe backslash (json)', ['--format=json'],
  '{"command":"create","path":"a\\\\b","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe a\\b\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe checked before exists', ['--format=json'],
  '{"command":"create","path":"../gone.txt","file_text":"x"}\n',
  {},
  { exit: 1, stdout: 'error: unsafe ../gone.txt\nfailed: 1 of 1 edits\n', files: {} });
add('x: unsafe move-to path (v4a)', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: a.txt\n*** Move to: ../b.txt\n*** End Patch\n',
  { 'a.txt': 'x\n' },
  { exit: 1, stdout: 'error: unsafe ../b.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'x\n' } });
add('x: unsafe path in search-replace', ['-'],
  '../x\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n',
  {},
  { exit: 1, stdout: 'error: unsafe ../x\nfailed: 1 of 1 edits\n', files: {} });

// ---------------------------------------------------------------------------
// Section 3: files, lines, mixed endings.
// ---------------------------------------------------------------------------
add('f: mixed endings treated as LF (first LF wins)', ['--format=json'],
  '{"command":"str_replace","path":"f.txt","old_str":"b\\r\\nc","new_str":"B"}\n',
  { 'f.txt': 'a\nb\r\nc\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'a\nB\n' } });
add('f: created nested dirs as needed', ['--format=json'],
  '{"command":"create","path":"a/b/c/d.txt","file_text":"deep\\n"}\n',
  {},
  { exit: 0, stdout: 'A a/b/c/d.txt\nok: 1 file\n', files: { 'a/b/c/d.txt': 'deep\n' } });
add('f: patch lines split at \\n, one trailing \\r removed', ['-'],
  'f.txt\r\n<<<<<<< SEARCH\r\na\r\n=======\r\nA\r\n>>>>>>> REPLACE\r\n',
  { 'f.txt': 'a\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'A\n' } });

add('v: anchor matched at tier 2 (leading ws differs)', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@ def foo():\n   x\n-    y\n+    z\n*** End Patch\n',
  { 'f.txt': '  def foo():\n    x\n    y\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': '  def foo():\n    x\n      z\n' } });
add('v: tier 2 re-indent in chunk', ['--format=v4a'],
  '*** Begin Patch\n*** Update File: f.txt\n@@\n session.payload = 1;\n return total * 2;\n-}\n+} // end\n*** End Patch\n',
  { 'f.txt': 'function f() {\n  session.payload = 1;\n  return total * 2;\n}\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'function f() {\n  session.payload = 1;\n  return total * 2;\n  } // end\n' } });
add('u: backslash as first body line is harmless', ['-'],
  '--- f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n\\ No newline at end of file\n-x\n+y\n',
  { 'f.txt': 'x\n' },
  { exit: 0, stdout: 'M f.txt\nok: 1 file\n', files: { 'f.txt': 'y\n' } });
add('j: JSONL line that is an array is a parse fault', ['--format=json'],
  '{"command":"create","path":"a.txt","file_text":"x"}\n[1,2]\n',
  {},
  { exit: 2, stdout: 'error: parse 2\n', files: {} });

// ---------------------------------------------------------------------------
// Runner: every case twice, byte-identical (determinism).
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
for (const c of cases) {
  const first = runCase(c);
  const second = runCase(c);
  const why = [];
  if (first.exit !== c.expect.exit) why.push(`exit ${first.exit}, expected ${c.expect.exit}`);
  if (first.stdout !== c.expect.stdout) why.push(`stdout ${JSON.stringify(first.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
  for (const p of new Set([...Object.keys(c.expect.files), ...Object.keys(first.files)])) {
    if (c.expect.files[p] === undefined) why.push(`${p} should not exist`);
    else if (first.files[p] === undefined) why.push(`${p} is missing`);
    else if (first.files[p] !== c.expect.files[p]) why.push(`${p} differs: expected ${JSON.stringify(c.expect.files[p])}, got ${JSON.stringify(first.files[p])}`);
  }
  if (second.exit !== first.exit || second.stdout !== first.stdout || JSON.stringify(second.files) !== JSON.stringify(first.files)) {
    why.push('second run differs (not deterministic)');
  }
  if (why.length === 0) passed += 1;
  else {
    failed += 1;
    process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
  }
}
process.stdout.write(`${passed} of ${cases.length} passed${failed === 0 ? '' : `, ${failed} failed`}\n`);
process.exit(failed === 0 ? 0 : 1);
