// Maintainability gate (principle 4.7): dependency direction, duplication and file size, checked on small fixture trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMaintainability } from '../src/gates/maintainability.mjs';
import { FAIL, NOT_EARNED, PASS } from '../src/gates/result.mjs';

// Writes `files` (repo-relative path → content; arrays become lines plus a final newline) into a fresh temp directory
// that is removed when the test ends.
function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-maintainability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Array.isArray(content) ? `${content.join('\n')}\n` : content);
  }
  return root;
}

const LAYER_RULE = { from: 'src/ui/**', mustNotImport: ['src/db/**'], reason: 'UI must not depend on the database' };

// Eight code lines and a closing brace: one duplication window and a little more.
const PRICING = [
  'export function priceWithTax(order, rates) {',
  '  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);',
  '  const discount = order.coupon ? (subtotal * order.coupon.percent) / 100 : 0;',
  '  const net = subtotal - discount;',
  '  const rate = rates[order.country] ?? rates.default;',
  '  const tax = Math.round(net * rate * 100) / 100;',
  '  const shipping = net > 100 ? 0 : order.shippingCost;',
  '  return { net, tax, shipping, total: net + tax + shipping };',
  '}',
];

const numbered = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`);
// [line, imported target as shown in the message] for each dependency finding.
const targets = (res) => res.evidence.findings.map((f) => [f.line, f.message.match(/ imports (\S+),/)[1]]);

test('[P4.7] dependency rule flags a forbidden import by its resolved path and leaves allowed imports alone', (t) => {
  const root = fixture(t, {
    'src/db/conn.mjs': ['export const conn = { query: () => [] };'],
    'src/service/users.mjs': [
      "import { conn } from '../db/conn.mjs';",
      "export const listUsers = () => conn.query('users');",
    ],
    'src/ui/view.mjs': [
      "// import { conn } from '../db/conn.mjs';",
      "import { listUsers } from '../service/users.mjs';",
      "import { conn } from '../db/conn';",
      'const note = "import x from \'../db/conn.mjs\'";',
      '/* export * from "../db/conn.mjs"; */',
      'export const render = () => [listUsers(), conn, note];',
    ],
  });
  const res = checkMaintainability({
    root, files: ['src/ui/view.mjs', 'src/service/users.mjs'], rules: { dependencyRules: [LAYER_RULE] },
  });
  assert.equal(res.id, 'maintainability');
  assert.equal(res.verdict, FAIL);
  assert.deepEqual(res.evidence.checkedFiles, ['src/service/users.mjs', 'src/ui/view.mjs']);
  assert.equal(res.evidence.findings.length, 1, res.remediation);
  const [f] = res.evidence.findings;
  assert.deepEqual([f.rule, f.file, f.line], ['dependency', 'src/ui/view.mjs', 3]);
  // The extensionless specifier is reported as the file it resolves to.
  assert.match(f.message, /^src\/ui\/view\.mjs:3 imports src\/db\/conn\.mjs, but UI must not depend on the database/);
  assert.match(f.remediation, /^Remove this import/);
});

test('[P4.7] dependency rule sees side-effect imports, re-exports, multi-line imports, import() and require()', (t) => {
  const root = fixture(t, {
    'src/db/index.mjs': ['export const db = {};'],
    'src/db/conn.mjs': ['export const conn = {};'],
    'src/db/setup.mjs': ['globalThis.ready = true;'],
    'src/db/legacy.cjs': ['module.exports = {};'],
    'src/ui/forms.mjs': [
      "import '../db/setup.mjs';",
      "export * from '../db/conn.mjs';",
      'import {',
      '  db,',
      "} from '../db';",
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const legacy = require('../db/legacy.cjs');",
      "export const load = () => import('../db/conn.mjs');",
      "export { conn as connection } from '../db/conn';",
      'export const view = () => [db, legacy];',
    ],
  });
  const res = checkMaintainability({ root, files: ['src/ui/forms.mjs'], rules: { dependencyRules: [LAYER_RULE] } });
  assert.equal(res.verdict, FAIL);
  assert.deepEqual(targets(res), [
    [1, 'src/db/setup.mjs'],
    [2, 'src/db/conn.mjs'],
    [3, 'src/db/index.mjs'],
    [8, 'src/db/legacy.cjs'],
    [9, 'src/db/conn.mjs'],
    [10, 'src/db/conn.mjs'],
  ]);
  assert.match(res.summary, /6 findings in 1 checked file \(6 dependency\)/);
  assert.match(res.remediation, /\.\.\.and 1 more in evidence\.findings\./);
});

test('[P4.7] dependency rule matches bare package specifiers as written', (t) => {
  const root = fixture(t, {
    'src/domain/order.mjs': [
      "import express from 'express';",
      "import { readFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "import fp from 'lodash/fp';",
      "import { money } from './money.mjs';",
      'export const order = () => [express, readFile, path, fp, money];',
    ],
    'src/domain/money.mjs': ['export const money = 1;'],
    'src/web/server.mjs': ["import express from 'express';", 'export const app = express;'],
  });
  const rule = { from: 'src/domain/**', mustNotImport: ['express', 'node:fs/**', 'lodash'], reason: 'the domain stays free of frameworks and IO' };
  const res = checkMaintainability({
    root, files: ['src/domain/order.mjs', 'src/domain/money.mjs', 'src/web/server.mjs'], rules: { dependencyRules: [rule] },
  });
  assert.equal(res.verdict, FAIL);
  // The raw specifier is matched: 'lodash/fp' is not 'lodash' (a rule meaning subpaths too says 'lodash/**').
  assert.deepEqual(targets(res), [[1, "'express'"], [2, "'node:fs/promises'"]]);
  assert.ok(res.evidence.findings.every((f) => f.file === 'src/domain/order.mjs'));
});

test('[P4.7] dependency findings keep exact line numbers after regexes, divisions and templates (LF and CRLF)', (t) => {
  // Each line is a trap: misreading it opens a comment, string or template that would swallow a later import.
  const tricky = [
    String.raw`const quote = /['"]\/\//g;`,
    String.raw`const stars = /\/*x/;`,
    'const tick = /`/;',
    'const share = total / count + `/`.length;',
    "const url = 'http://example.com/a'; const legacy = require('../db/legacy.cjs');",
    "const text = `first line isn't short",
    '${ { x: \'}\' }.x + `/* not a comment`.length } and ${`nested ${share}`}',
    'last line`;',
    "export const load = () => import('../db/conn.mjs');",
    '/* a block comment',
    '   spanning lines */ const msg = "it\'s fine";',
    'export const tpl = `${tick} ${stars} ${quote} ${msg} ${url}`; /* end */',
    "export * from '../db/conn.mjs';",
  ];
  const rules = { dependencyRules: [{ from: 'src/app/**', mustNotImport: ['src/db/**'], reason: 'the app reaches storage through services' }] };
  for (const eol of ['\n', '\r\n']) {
    const root = fixture(t, {
      'src/db/conn.mjs': ['export const conn = {};'],
      'src/db/legacy.cjs': ['module.exports = {};'],
      'src/app/tricky.mjs': tricky.join(eol) + eol,
    });
    const res = checkMaintainability({ root, files: ['src/app/tricky.mjs'], rules });
    assert.deepEqual(targets(res), [[5, 'src/db/legacy.cjs'], [9, 'src/db/conn.mjs'], [13, 'src/db/conn.mjs']],
      `line endings ${JSON.stringify(eol)}`);
  }
});

test('[P4.7] max file lines flags files over the limit and accepts files at the limit', (t) => {
  const root = fixture(t, {
    'src/big.mjs': numbered(11),
    'src/exact.mjs': numbered(10),
    'src/exact-no-eol.mjs': numbered(10).join('\n'),
    'docs/long.md': numbered(50),
  });
  const res = checkMaintainability({
    root, files: ['src/big.mjs', 'src/exact.mjs', 'src/exact-no-eol.mjs', 'docs/long.md'], rules: { maxFileLines: 10 },
  });
  assert.equal(res.verdict, FAIL);
  assert.deepEqual(res.evidence.checkedFiles, ['src/big.mjs', 'src/exact-no-eol.mjs', 'src/exact.mjs']);
  assert.equal(res.evidence.findings.length, 1, res.remediation);
  const [f] = res.evidence.findings;
  assert.deepEqual([f.rule, f.file, f.line], ['max-file-lines', 'src/big.mjs', 11]);
  assert.match(f.message, /^src\/big\.mjs has 11 lines, over the limit of 10\. Split /);
});

test('[P4.7] duplication across two files is reported once, however many of them are checked', (t) => {
  // The same code re-indented, with an inserted comment line and a trailing comment: normalisation still matches it.
  const copy = PRICING.map((l) => `    ${l}`.replace('(order, rates)', '(order,   rates)'));
  copy.splice(2, 0, '        // keep in sync with src/a.mjs');
  copy[4] += ' // after coupons';
  const root = fixture(t, {
    'src/a.mjs': [
      "import { rates } from './rates.mjs';",
      '',
      "export const currency = 'EUR';",
      ...PRICING,
      'export const label = (order) => `${order.id}: ${currency}`;',
    ],
    'src/b.mjs': ['// Billing copy of the pricing code.', 'const vat = 0.2;', ...copy, 'export const vatRate = () => vat;'],
  });
  const check = (files) => checkMaintainability({ root, files, rules: { duplication: {} } });
  const where = (res) => res.evidence.findings.map((f) => [f.rule, f.file, f.line]);

  const onlyA = check(['src/a.mjs']);
  assert.equal(onlyA.verdict, FAIL);
  assert.deepEqual(where(onlyA), [['duplication', 'src/a.mjs', 4]]);
  assert.match(onlyA.evidence.findings[0].message, /^src\/a\.mjs:4-11 duplicates 8 code lines at src\/b\.mjs:3-11\./);

  assert.deepEqual(where(check(['src/a.mjs', 'src/b.mjs'])), [['duplication', 'src/a.mjs', 4]]);

  const onlyB = check(['src/b.mjs']);
  assert.deepEqual(where(onlyB), [['duplication', 'src/b.mjs', 3]]);
  assert.match(onlyB.evidence.findings[0].message, /^src\/b\.mjs:3-11 duplicates 8 code lines at src\/a\.mjs:4-11\./);
});

test('[P4.7] duplication ignores repeated braces, short lines, comments and copies under node_modules or .git', (t) => {
  const closers = ['      });', '    });', '  ]);', '}', '};', ')', '];', '}', '});', '  };', '},', '),'];
  const short = ['a();', 'b();', 'c();', 'd();', 'e();', 'f();', 'g();'];
  const doc = [
    '/**',
    ' * Computes the order total including tax, discounts and shipping for the given country.',
    ' * Rates come from the configuration service and are cached for one hour.',
    ' */',
    '// The same comment text appears in several files on purpose: it must never count as code.',
    '// Another long comment line that pushes any window well past sixty characters.',
  ];
  // Three shared code lines: only counting the closing lines after them would make a six-line window.
  const route = [
    "app.get('/users', authenticate, async (req, res) => {",
    '  const page = await listUsers({ filter: req.query.filter, page: Number(req.query.page ?? 1) });',
    "  res.set('cache-control', 'no-store').json({ items: page.items, next: page.next });",
    '    });',
    '  });',
    '});',
    '}',
  ];
  const root = fixture(t, {
    'src/one.mjs': [...doc, ...short, ...closers, ...doc, ...PRICING],
    'src/two.mjs': [...doc, ...closers, ...short, ...closers, ...doc],
    'src/routes-a.mjs': [...route, 'export const a = 1;'],
    'src/routes-b.mjs': [...route, 'export const b = 2;'],
    'node_modules/pricing/index.js': PRICING,
    '.git/hooks/pricing.js': PRICING,
  });
  const files = ['src/one.mjs', 'src/two.mjs', 'src/routes-a.mjs', 'src/routes-b.mjs'];
  const res = checkMaintainability({ root, files, rules: { duplication: {} } });
  assert.deepEqual(res.evidence.findings, []);
  assert.equal(res.verdict, PASS);
});

test('[P4.7] duplication skips shared import and require headers', (t) => {
  const header = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { createHash } from 'node:crypto';",
    "import { gateResult, PASS, FAIL } from './result.mjs';",
    'import {',
    '  globToRegExp,',
    '  listFiles,',
    "} from '../util.mjs';",
    "const { spawnSync } = require('node:child_process');",
    "const legacy = require('../legacy.cjs');",
  ];
  const shared = [
    'export const describeRun = (run) => `${run.id} finished with ${run.verdict} after ${run.attempts} attempts`;',
    "export const isFinished = (run) => run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';",
    'export const elapsedMs = (run) => (run.finishedAt ?? Date.now()) - run.startedAt - (run.pausedMs ?? 0);',
  ];
  const root = fixture(t, {
    'src/first.mjs': [...header, ...shared, 'export const first = () => [fs, path, createHash, legacy];'],
    'src/second.mjs': [...header, ...shared, 'export const second = () => [gateResult, PASS, FAIL, spawnSync];'],
  });
  const res = checkMaintainability({ root, files: ['src/first.mjs', 'src/second.mjs'], rules: { duplication: { minLines: 3 } } });
  // Counting the ten identical header lines would stretch the region back to line 1.
  assert.deepEqual(res.evidence.findings.map((f) => [f.file, f.line]), [['src/first.mjs', 11]]);
  assert.match(res.evidence.findings[0].message, /^src\/first\.mjs:11-13 duplicates 3 code lines at src\/second\.mjs:11-13\./);
});

test('[P4.7] duplication inside one file counts only non-overlapping repeats', (t) => {
  const body = PRICING.slice(1, -1);
  const root = fixture(t, {
    'src/calc.mjs': [
      'export function retailPrice(order, rates) {',
      ...body,
      '}',
      'export function wholesalePrice(order, rates) {',
      ...body,
      '}',
    ],
    'src/seven.mjs': Array(7).fill('total = total + computeLineAmount(order.items[index], rates, options);'),
    'src/twelve.mjs': Array(12).fill('count = count + countMatchingEntries(store.entries[index], filters, options);'),
  });
  const res = checkMaintainability({
    root, files: ['src/calc.mjs', 'src/seven.mjs', 'src/twelve.mjs'], rules: { duplication: {} },
  });
  // Seven identical lines only overlap themselves; twelve hold two separate copies of a six-line window.
  assert.deepEqual(res.evidence.findings.map((f) => f.message.split('. ')[0]), [
    'src/calc.mjs:2-8 duplicates 7 code lines at src/calc.mjs:11-17',
    'src/twelve.mjs:1-6 duplicates 6 code lines at src/twelve.mjs:7-12',
  ]);
});

test('[P4.7] NOT-EARNED when no rule is configured', (t) => {
  const root = fixture(t, { 'src/a.mjs': ['export const a = 1;'] });
  for (const rules of [undefined, null, {}, { dependencyRules: [] }, { duplication: false }, { sourceGlobs: ['**/*.mjs'] }]) {
    const res = checkMaintainability({ root, files: ['src/a.mjs'], rules });
    assert.equal(res.verdict, NOT_EARNED, String(JSON.stringify(rules)));
    assert.match(res.summary, /no maintainability rule is configured/);
  }
});

test('[P4.7] NOT-EARNED when no checked file is an existing source file', (t) => {
  const root = fixture(t, { 'src/a.mjs': ['export const a = 1;'], 'README.md': ['# Readme'] });
  const cases = [
    { files: [] },
    { files: ['README.md'] },
    { files: ['src/deleted.mjs'] },
    { files: ['../outside.mjs', 'node_modules/pkg/index.js'] },
    { files: ['src/a.mjs'], sourceGlobs: ['lib/**/*.mjs'] },
  ];
  for (const { files, sourceGlobs } of cases) {
    const res = checkMaintainability({ root, files, rules: { maxFileLines: 100, sourceGlobs } });
    assert.equal(res.verdict, NOT_EARNED, JSON.stringify(files));
    assert.deepEqual(res.evidence.checkedFiles, []);
  }
});

test('[P4.7] an invalid rule never passes silently', (t) => {
  const root = fixture(t, { 'src/a.mjs': ['export const a = 1;', 'export const b = 2;'] });
  const check = (rules) => checkMaintainability({ root, files: ['src/a.mjs'], rules });
  const typo = check({ maxFileLines: 100, dependencyRules: [{ from: 'src/**', mustNotImports: ['src/db/**'] }] });
  assert.equal(typo.verdict, NOT_EARNED);
  assert.match(typo.summary, /dependencyRules\[0\] needs from and mustNotImport/);
  assert.equal(check({ maxFileLines: '300' }).verdict, NOT_EARNED);
  assert.equal(check({ duplication: { minLines: 0 } }).verdict, NOT_EARNED);
  // Findings from the valid rules still fail the gate.
  assert.equal(check({ maxFileLines: 1, dependencyRules: [{ from: 'src/**' }] }).verdict, FAIL);
});

test('[P4.7] PASS when rules are configured and the checked files comply', (t) => {
  const root = fixture(t, {
    'src/db/conn.mjs': ['export const conn = {};'],
    'src/service/users.mjs': ["import { conn } from '../db/conn.mjs';", 'export const users = () => conn;'],
    'src/ui/view.mjs': ["import { users } from '../service/users.mjs';", 'export const view = () => users();'],
  });
  const res = checkMaintainability({
    root,
    files: ['src/ui/view.mjs', 'src/service/users.mjs'],
    rules: { maxFileLines: 50, dependencyRules: [LAYER_RULE], duplication: { minLines: 6 } },
  });
  assert.equal(res.id, 'maintainability');
  assert.equal(res.verdict, PASS);
  assert.deepEqual(res.evidence, {
    findings: [],
    checkedFiles: ['src/service/users.mjs', 'src/ui/view.mjs'],
    checks: ['max-file-lines', 'dependency', 'duplication'],
  });
  assert.equal(res.remediation, null);
  assert.ok(Number.isFinite(res.durationMs) && res.durationMs >= 0);
});

test('[P4.7] every finding says what is wrong and how to fix it', (t) => {
  const root = fixture(t, {
    'src/db/conn.mjs': ['export const conn = {};'],
    'src/ui/big.mjs': ["import { conn } from '../db/conn.mjs';", ...PRICING, ...numbered(30)],
    'src/ui/copy.mjs': PRICING,
  });
  const rule = { ...LAYER_RULE, remediation: 'Call it through src/service/ instead.' };
  const res = checkMaintainability({
    root, files: ['src/ui/big.mjs'], rules: { maxFileLines: 30, dependencyRules: [rule], duplication: {} },
  });
  assert.equal(res.verdict, FAIL);
  const findings = res.evidence.findings;
  assert.deepEqual(findings.map((f) => [f.rule, f.line]), [['dependency', 1], ['duplication', 2], ['max-file-lines', 31]]);
  for (const f of findings) {
    assert.ok(f.remediation.length > 20, f.rule);
    assert.ok(f.message.startsWith('src/ui/big.mjs'), f.message);
    assert.ok(f.message.endsWith(f.remediation), f.message);
    assert.ok(res.remediation.includes(f.message), 'the gate remediation lists the finding messages');
  }
  assert.equal(findings[0].message, 'src/ui/big.mjs:1 imports src/db/conn.mjs, but UI must not depend on the database '
    + '(rule: src/ui/** must not import src/db/**). Call it through src/service/ instead.');
  assert.match(findings[1].message, /^src\/ui\/big\.mjs:2-9 duplicates 8 code lines at src\/ui\/copy\.mjs:1-8\. Extract /);
  assert.match(findings[2].message, /^src\/ui\/big\.mjs has 40 lines, over the limit of 30\. Split /);
  assert.match(res.summary, /3 findings in 1 checked file \(1 max-file-lines, 1 dependency, 1 duplication\)/);
  assert.deepEqual(res.feedback, { summary: res.summary, remediation: res.remediation });
});
