// Policy hook decisions, driven by real PreToolUse payloads captured from Claude Code 2.1.296 on Windows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../src/policy/hook.mjs';
import { IS_WIN } from '../src/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hook-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const ws = path.join(root, 'ws');
fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
fs.writeFileSync(path.join(root, 'outside', 'secret.txt'), 'holdout');

// The payloads were captured on Windows; elsewhere their path separators (JSON-escaped backslashes) become '/'.
const fixtures = fs.readFileSync(path.join(here, 'fixtures', 'claude-hook-payloads.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse((IS_WIN ? l : l.replaceAll('\\\\', '/')).replaceAll('{ROOT}', root.replaceAll('\\', '\\\\'))));
const policy = { workspace: ws, protected: ['test/**', '.factory/**'], readDeny: ['**/.env'], bashAllow: ['node --test'], networkAllowed: false };
const call = (tool_name, tool_input, extra = {}) => decide({ tool_name, tool_input, cwd: ws, ...extra }, policy);

test('[P5.2] real payload: Read outside the workspace is denied', () => {
  const p = fixtures.find((f) => f.tool_name === 'Read' && f.tool_input.file_path.includes('outside'));
  assert.equal(decide(p, policy).decision, 'deny');
});

test('[P4.2] real payload: Edit of a protected test is denied', () => {
  const p = fixtures.find((f) => f.tool_name === 'Edit');
  assert.equal(decide(p, policy).decision, 'deny');
  assert.match(decide(p, policy).reason, /protected/);
});

test('[P5.2] real payloads: Glob on the workspace root and Write inside it are allowed', () => {
  for (const p of fixtures.filter((f) => f.tool_name === 'Glob' || f.tool_name === 'Write')) {
    assert.equal(decide(p, policy).decision, 'allow', JSON.stringify(p.tool_input));
  }
});

test('[P5.2] real payload: the allowed test command runs, a one-liner does not', () => {
  const allowed = fixtures.find((f) => f.tool_name === 'Bash' && f.tool_input.command === 'node --test');
  assert.equal(decide(allowed, policy).decision, 'allow');
  const other = fixtures.find((f) => f.tool_name === 'Bash' && f.tool_input.command.startsWith('node -e'));
  assert.equal(decide(other, policy).decision, 'deny');
});

test('[P5.2] path tricks cannot escape the workspace', () => {
  const tricks = [
    path.join(ws, '..', 'outside', 'secret.txt'),
    '../outside/secret.txt',
    `${ws}/../outside/secret.txt`.replaceAll('\\', '/'),
    path.join(root, 'outside', 'secret.txt'),
  ];
  if (IS_WIN) {
    tricks.push(path.join(root, 'outside', 'secret.txt').replace(/^([a-z]):/i, (d) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase())));
    tricks.push('\\\\?\\' + path.join(root, 'outside', 'secret.txt'));
  }
  for (const t of tricks) assert.equal(call('Read', { file_path: t }).decision, 'deny', t);
  assert.equal(call('Grep', { pattern: 'x', path: '..' }).decision, 'deny');
  assert.equal(call('Glob', { pattern: '../outside/*' }).decision, 'deny');
});

test('[P5.2] a junction or symlink inside the workspace pointing outside is followed and denied', (t) => {
  const link = path.join(ws, 'escape');
  try { fs.symlinkSync(path.join(root, 'outside'), link, 'junction'); } catch (error) { t.skip(`cannot create link: ${error.code}`); return; }
  try {
    assert.equal(call('Read', { file_path: path.join(link, 'secret.txt') }).decision, 'deny');
  } finally { fs.rmSync(link, { recursive: true, force: true }); }
});

test('[P5.2] chained, piped or redirected commands are denied even when they start with an allowed command', () => {
  for (const command of ['node --test && type secret.txt', 'node --test; cat x', 'node --test | tee out', 'node --test > out.txt', 'node --test $(cat x)', 'node --test `x`', 'node --test\ncat x',
    'node --test & echo pwned', 'node --test &rm file', 'node --test || x', 'node --test <(cat x)']) {
    assert.equal(call('Bash', { command }).decision, 'deny', command);
  }
  assert.equal(call('Bash', { command: 'node --test --test-reporter=tap' }).decision, 'allow');
  assert.equal(call('Bash', { command: 'node --testing' }).decision, 'deny');
});

test('[P5.1][P5.2] network tools are denied for roles without external communication', () => {
  assert.equal(call('WebFetch', { url: 'https://example.com' }).decision, 'deny');
  assert.equal(decide({ tool_name: 'WebFetch', tool_input: {}, cwd: ws }, { ...policy, networkAllowed: true }).decision, 'allow');
});

test('[P8.3] the data boundary denies matching files inside the workspace', () => {
  assert.equal(call('Read', { file_path: path.join(ws, 'config', '.env') }).decision, 'deny');
  assert.equal(call('Read', { file_path: path.join(ws, 'slug.mjs') }).decision, 'allow');
});

test('[P3.3] the kill switch denies every call and can disable one tool', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: path.join(ws, 'a') }, cwd: ws }, policy, { engaged: true }).decision, 'deny');
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: path.join(ws, 'a') }, cwd: ws }, policy, { engaged: false, disabledTools: ['Read'] }).decision, 'deny');
});

test('[P5.4] factory files in the workspace are protected from edits', () => {
  assert.equal(call('Write', { file_path: path.join(ws, '.factory', 'progress.md'), content: 'x' }).decision, 'deny');
  assert.equal(call('Read', { file_path: path.join(ws, '.factory', 'MAP.md') }).decision, 'allow');
});

test('[P5.2] unknown tools are denied by default', () => {
  assert.equal(call('Task', { prompt: 'x' }).decision, 'deny');
});

test('[P5.2][mechanism-off] with the workspace boundary widened to the filesystem root, the outside read is allowed', () => {
  const p = fixtures.find((f) => f.tool_name === 'Read' && f.tool_input.file_path.includes('outside'));
  assert.equal(decide(p, { ...policy, workspace: path.parse(root).root }).decision, 'allow');
});

test('[P4.3] the hook program fails closed on a broken policy file and writes the deny decision as Claude Code expects', () => {
  const hook = path.join(here, '..', 'src', 'policy', 'hook.mjs');
  const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(ws, 'x') }, cwd: ws });
  const res = spawnSync(process.execPath, [hook], { input: payload, encoding: 'utf8', env: { ...process.env, FACTORY_HOOK_POLICY: path.join(root, 'missing.json') } });
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /failing closed/);
});

test('[P6.1] the hook program appends an execute_tool span with redacted content', () => {
  const hook = path.join(here, '..', 'src', 'policy', 'hook.mjs');
  const trace = path.join(root, 'trace.jsonl');
  const policyFile = path.join(root, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ ...policy, trace, role: 'builder', runId: 'r1', captureContent: false }));
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(ws, 'a.mjs'), content: 'SECRET-CONTENT' }, cwd: ws });
  spawnSync(process.execPath, [hook], { input: payload, encoding: 'utf8', env: { ...process.env, FACTORY_HOOK_POLICY: policyFile } });
  const span = JSON.parse(fs.readFileSync(trace, 'utf8').trim().split('\n').pop());
  assert.equal(span.kind, 'execute_tool');
  assert.equal(span.attributes['factory.decision'], 'allow');
  assert.ok(!JSON.stringify(span).includes('SECRET-CONTENT'));
});
