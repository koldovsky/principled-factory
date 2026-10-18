// Principle 4.5 «test the tests»: mutants on the changed lines must be killed by the visible tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateMutants, runMutation } from '../src/gates/mutation.mjs';
import { FAIL, NOT_EARNED, PASS } from '../src/gates/result.mjs';

let version = 0;
// A new module instance per call (cache-busting query), so each test run sees the file as it is on disk now.
const importFresh = (file) => import(`${pathToFileURL(file).href}?v=${++version}`);

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const brief = (mutants) => mutants.map(({ line, operator, mutated }) => ({ line, operator, mutated }));

// A runTests callback: passes when `checks` holds against a fresh import of the module.
const suite = (file, checks) => async () => {
  try {
    checks(await importFresh(file));
    return { passed: true };
  } catch {
    return { passed: false };
  }
};

// Every mutant of this module is killable: 9 candidates, none of them a syntax error.
const SLUG = [
  'export function slugify(text, keepCase = false) {',
  '  let s = text.trim();',
  '  if (keepCase === false) s = s.toLowerCase();',
  "  return s.replace(/\\s+/g, '-');",
  '}',
  'export function inRange(n, lo, hi) {',
  '  return n >= lo && n <= hi;',
  '}',
  '',
].join('\n');

test('[P4.5] each operator yields one mutant per occurrence with the expected mutated line', (t) => {
  const src = [
    'export function f(a, b, s) {',
    '  if (a === b) return 1;',
    '  if (a !== b) return 2;',
    '  if (a == b) return 3;',
    '  if (a != b) return 4;',
    '  const both = a && b;',
    '  const either = a || b;',
    '  const ge = a >= b;',
    '  const le = a <= b;',
    '  const gt = a > b;',
    '  const lt = a < b;',
    '  const yes = true;',
    '  const no = false;',
    '  const t = s.trim();',
    '  const l = s.toLowerCase();',
    '  const o = s?.trim();',
    "  const r = s.replace(/-+/g, '-');",
    '  const all = a && b && yes;',
    '  return [both, either, ge, le, gt, lt, yes, no, t, l, o, r, all];',
    '}',
    '',
  ].join('\n');
  const root = makeRepo(t, { 'src/ops.mjs': src });
  const mutants = generateMutants({ root, files: ['src/ops.mjs'], maxMutants: 100 });
  assert.deepEqual(brief(mutants), [
    { line: 2, operator: "'===' → '!=='", mutated: '  if (a !== b) return 1;' },
    { line: 3, operator: "'!==' → '==='", mutated: '  if (a === b) return 2;' },
    { line: 4, operator: "'==' → '!='", mutated: '  if (a != b) return 3;' },
    { line: 5, operator: "'!=' → '=='", mutated: '  if (a == b) return 4;' },
    { line: 6, operator: "'&&' → '||'", mutated: '  const both = a || b;' },
    { line: 7, operator: "'||' → '&&'", mutated: '  const either = a && b;' },
    { line: 8, operator: "'>=' → '<'", mutated: '  const ge = a < b;' },
    { line: 9, operator: "'<=' → '>'", mutated: '  const le = a > b;' },
    { line: 10, operator: "'>' → '<='", mutated: '  const gt = a <= b;' },
    { line: 11, operator: "'<' → '>='", mutated: '  const lt = a >= b;' },
    { line: 12, operator: "'true' → 'false'", mutated: '  const yes = false;' },
    { line: 13, operator: "'false' → 'true'", mutated: '  const no = true;' },
    { line: 14, operator: "'.trim()' → ''", mutated: '  const t = s;' },
    { line: 15, operator: "'.toLowerCase()' → ''", mutated: '  const l = s;' },
    { line: 16, operator: "'.trim()' → ''", mutated: '  const o = s;' },
    { line: 17, operator: "'/g' → '/'", mutated: "  const r = s.replace(/-+/, '-');" },
    { line: 18, operator: "'&&' → '||'", mutated: '  const all = a || b && yes;' },
    { line: 18, operator: "'&&' → '||'", mutated: '  const all = a && b || yes;' },
  ]);
  const columns = (line) => mutants.filter((m) => m.line === line).map((m) => m.column);
  assert.deepEqual(columns(2), [9]); // first '=' of '==='
  assert.deepEqual(columns(8), [16]); // the '>', not the surrounding space
  assert.deepEqual(columns(16), [14]); // the '?' of '?.trim()'
  assert.deepEqual(columns(17), [26]); // the regex's closing slash
  assert.deepEqual(columns(18), [17, 22]);
  assert.equal(mutants[0].file, 'src/ops.mjs');
  assert.equal(mutants[0].original, '  if (a === b) return 1;');
});

test('[P4.5] arrows, strings, template text, comments and unspaced comparisons are not mutated', (t) => {
  const src = [
    '#!/usr/bin/env node',
    'export const pos = x=>x>0;',
    'export const big = (a) => a > 0;',
    'export const ge = (a, b) => a>=b;',
    "export const s1 = 'a === b && c || true';",
    'export const s2 = "x != y || false";',
    'export const tpl = `a > b ${1} false`;',
    'export const multi = `first',
    '  a === b && true',
    '  last`;',
    'export const expr = (a, b) => `${a && b}`;',
    'export const quote = /[\'"`]/g;',
    'export const after = (a, b) => a || b;',
    'export const avg = (a, b) => (a + b) / 2 > 1;',
    "export const k = 1; // it's a && b",
    '// if (a === b) return true;',
    '/*',
    '  a === b',
    '*/',
    '/**',
    ' * c || d',
    ' */',
    'export const words = (o, untrue) => o.true || untrue;',
    '',
  ].join('\n');
  const root = makeRepo(t, { 'src/safe.mjs': src });
  assert.deepEqual(brief(generateMutants({ root, files: ['src/safe.mjs'], maxMutants: 100 })), [
    { line: 3, operator: "'>' → '<='", mutated: 'export const big = (a) => a <= 0;' },
    { line: 11, operator: "'&&' → '||'", mutated: 'export const expr = (a, b) => `${a || b}`;' },
    { line: 12, operator: "'/g' → '/'", mutated: 'export const quote = /[\'"`]/;' },
    { line: 13, operator: "'||' → '&&'", mutated: 'export const after = (a, b) => a && b;' },
    { line: 14, operator: "'>' → '<='", mutated: 'export const avg = (a, b) => (a + b) / 2 <= 1;' },
    { line: 23, operator: "'||' → '&&'", mutated: 'export const words = (o, untrue) => o.true && untrue;' },
  ]);
});

test('[P4.5] changedLines restricts mutation to the listed lines of the listed files', (t) => {
  const root = makeRepo(t, {
    'src/a.mjs': 'export const x = (a, b) => a && b;\nexport const y = (a, b) => a || b;\nexport const z = (a, b) => a === b;\n',
    'src/b.mjs': 'export const w = (a) => a === true;\n',
  });
  const files = ['src/a.mjs', 'src/b.mjs'];
  assert.equal(generateMutants({ root, files, maxMutants: 100 }).length, 5);
  const only = generateMutants({ root, files, changedLines: { 'src/a.mjs': [2] }, maxMutants: 100 });
  assert.deepEqual(only.map((m) => `${m.file}:${m.line} ${m.mutated}`), ['src/a.mjs:2 export const y = (a, b) => a && b;']);
});

test('[P4.5] the mutant budget is spread round-robin across files, deterministically', (t) => {
  const six = Array.from({ length: 6 }, (_, i) => `export const f${i} = (a, b) => a && b;`).join('\n');
  const root = makeRepo(t, { 'src/a.mjs': six, 'src/b.mjs': six, 'src/c.mjs': 'export const g = (a, b) => a || b;\n' });
  const files = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'];
  const picked = generateMutants({ root, files, maxMutants: 5 });
  // Quotas a=2, b=2, c=1, interleaved; within a file the picks are spread (lines 1 and 4 of 6), not the first two.
  assert.deepEqual(picked.map((m) => `${m.file}:${m.line}`),
    ['src/a.mjs:1', 'src/b.mjs:1', 'src/c.mjs:1', 'src/a.mjs:4', 'src/b.mjs:4']);
  assert.deepEqual(generateMutants({ root, files, maxMutants: 5 }), picked);
  assert.deepEqual(generateMutants({ root, files: [...files].reverse(), maxMutants: 5 }), picked);
  assert.deepEqual(generateMutants({ root, files, maxMutants: 2 }).map((m) => m.file), ['src/a.mjs', 'src/b.mjs']);
});

test('[P4.5] a strong test suite kills every mutant (PASS) and the source is left intact', async (t) => {
  const root = makeRepo(t, { 'src/slug.mjs': SLUG });
  const file = path.join(root, 'src/slug.mjs');
  const result = await runMutation({
    root,
    files: ['src/slug.mjs'],
    runTests: suite(file, (m) => {
      assert.equal(m.slugify('  Hello World  '), 'hello-world');
      assert.equal(m.slugify('a  b c'), 'a-b-c');
      assert.equal(m.slugify('Keep Case', true), 'Keep-Case');
      assert.equal(m.inRange(5, 1, 10), true);
      assert.equal(m.inRange(1, 1, 10), true);
      assert.equal(m.inRange(10, 1, 10), true);
      assert.equal(m.inRange(0, 1, 10), false);
      assert.equal(m.inRange(11, 1, 10), false);
    }),
  });
  assert.equal(result.id, 'mutation');
  assert.equal(result.verdict, PASS);
  const { total, killed, errors, score, survived } = result.evidence;
  assert.deepEqual({ total, killed, errors, score, survived }, { total: 9, killed: 9, errors: 0, score: 1, survived: [] });
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(fs.readFileSync(file, 'utf8'), SLUG);
});

test('[P4.5] a weak test suite lets mutants survive (FAIL) with survivors named in the remediation', async (t) => {
  const root = makeRepo(t, { 'src/slug.mjs': SLUG });
  const file = path.join(root, 'src/slug.mjs');
  const result = await runMutation({
    root,
    files: ['src/slug.mjs'],
    runTests: suite(file, (m) => {
      assert.equal(typeof m.slugify, 'function');
      assert.equal(typeof m.inRange, 'function');
    }),
  });
  assert.equal(result.verdict, FAIL);
  assert.equal(result.evidence.killed, 0);
  assert.equal(result.evidence.score, 0);
  assert.equal(result.evidence.survived.length, 9);
  assert.deepEqual(result.remediation.split('\n'), [
    "add a test that fails when 'false' → 'true' is applied at src/slug.mjs:1 (export function slugify(text, keepCase = false) {)",
    "add a test that fails when '.trim()' → '' is applied at src/slug.mjs:2 (let s = text.trim();)",
    "add a test that fails when '===' → '!==' is applied at src/slug.mjs:3 (if (keepCase === false) s = s.toLowerCase();)",
    '(6 more survivors in the evidence)',
  ]);
  assert.equal(result.feedback.remediation, result.remediation);
  assert.equal(fs.readFileSync(file, 'utf8'), SLUG);
});

test('[P4.5] no mutants means nothing was verified (NOT-EARNED) and the tests are never run', async (t) => {
  const root = makeRepo(t, {
    'src/plain.mjs': "export const name = 'a && b';\nexport const n = 1;\n",
    'src/ops.mjs': 'export const x = (a, b) => a && b;\nexport const k = 2;\n',
  });
  let calls = 0;
  const runTests = async () => { calls++; return { passed: true }; };
  const none = await runMutation({ root, files: ['src/plain.mjs'], runTests });
  assert.equal(none.verdict, NOT_EARNED);
  assert.equal(none.evidence.total, 0);
  assert.equal(none.evidence.score, null);
  const untouched = await runMutation({ root, files: ['src/ops.mjs'], changedLines: { 'src/ops.mjs': [2] }, runTests });
  assert.equal(untouched.verdict, NOT_EARNED);
  assert.equal(calls, 0);
});

test('[P4.5] original bytes are restored when runTests throws, and errors are not counted as kills', async (t) => {
  // BOM, CRLF and no trailing newline: any re-encoding or line-ending slip would show in the bytes.
  const original = Buffer.from('﻿export const both = (a, b) => a && b;\r\nexport const either = (a, b) => a || b;', 'utf8');
  const root = makeRepo(t, { 'src/crlf.mjs': original });
  const file = path.join(root, 'src/crlf.mjs');
  const seen = [];
  const result = await runMutation({
    root,
    files: ['src/crlf.mjs'],
    runTests: async () => {
      seen.push(fs.readFileSync(file, 'utf8'));
      throw new Error('test runner crashed');
    },
  });
  // Each mutant really was on disk while the tests ran...
  assert.deepEqual(seen, [
    '﻿export const both = (a, b) => a || b;\r\nexport const either = (a, b) => a || b;',
    '﻿export const both = (a, b) => a && b;\r\nexport const either = (a, b) => a && b;',
  ]);
  // ...and the original bytes are back afterwards.
  assert.ok(fs.readFileSync(file).equals(original));
  assert.equal(result.verdict, NOT_EARNED);
  assert.deepEqual([result.evidence.total, result.evidence.killed, result.evidence.errors], [2, 0, 2]);
  assert.match(result.summary, /test runner crashed/);
});

test('[P4.5] files outside the root are never mutated', (t) => {
  const outer = makeRepo(t, {
    'outside.mjs': 'export const x = (a, b) => a && b;\n',
    'repo/src/in.mjs': 'export const y = (a, b) => a || b;\n',
  });
  const root = path.join(outer, 'repo');
  const mutants = generateMutants({ root, files: ['../outside.mjs', 'src/in.mjs'], maxMutants: 100 });
  assert.deepEqual(mutants.map((m) => m.file), ['src/in.mjs']);
});
