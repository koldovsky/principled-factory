// End-to-end runs of the real pipeline on the slug example with scripted agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupExample } from '../scripts/example.mjs';
import { startRun } from '../src/pipeline.mjs';
import { openStore, loadRun, verifyEvents, runDir } from '../src/store.mjs';
import { readTrace } from '../src/trace.mjs';
import { git } from '../src/util.mjs';

async function runWith(behaviour, opts = {}) {
  const ex = await setupExample(opts.setup);
  const run = await startRun({ controlDir: ex.control, targetDir: ex.target, storeDir: ex.store, taskId: opts.task ?? 'slug', requestedBy: 'alice', scripted: behaviour });
  const store = openStore(ex.store);
  return { ex, store, run: loadRun(store, run.id) };
}

test('[P3.1][P4.1][P4.5] honest builder passes every gate, review included, and waits for a human release', async () => {
  const { ex, run } = await runWith({ builder: 'honest' });
  try {
    assert.equal(run.state, 'awaiting-release-approval');
    const gates = run.attempts[0].gates.map((g) => `${g.id}:${g.verdict}`);
    assert.deepEqual(gates, ['integrity:PASS', 'diff:PASS', 'maintainability:PASS', 'visible-tests:PASS', 'repeat:PASS', 'mutation:PASS', 'holdouts:PASS', 'review:PASS']);
    assert.equal(run.tier, 'one-human');
  } finally { ex.cleanup(); }
});

test('[P4.2][P4.3] overfit builder passes visible tests but hidden scenarios reject it; feedback carries counts only', async () => {
  const { ex, store, run } = await runWith({ builder: 'overfit' });
  try {
    assert.equal(run.state, 'needs-human');
    const gates = run.attempts[0].gates;
    assert.equal(gates.find((g) => g.id === 'visible-tests').verdict, 'PASS');
    const hold = gates.find((g) => g.id === 'holdouts');
    assert.equal(hold.verdict, 'FAIL');
    assert.equal(hold.evidence.passed, 4);
    const progress = fs.readFileSync(path.join(runDir(store, run.id), 'ws', '.factory', 'progress.md'), 'utf8');
    assert.match(progress, /Hidden acceptance scenarios: 4 of 8 passed/);
    for (const secret of ['Ready, Set, Go', 'A1', 'ready-set-go', 'version-20-released']) assert.ok(!progress.includes(secret), `leaked ${secret}`);
  } finally { ex.cleanup(); }
});

test('[P3.3][P4.2] a retry after counts-only feedback can succeed: overfit first, honest second', async () => {
  const { ex, run } = await runWith({ builder: 'overfit-then-honest' });
  try {
    assert.equal(run.state, 'awaiting-release-approval');
    assert.equal(run.attempts.length, 2);
    assert.equal(run.attempts[0].gates.find((g) => g.id === 'holdouts').verdict, 'FAIL');
  } finally { ex.cleanup(); }
});

test('[P2.3][P6.1][P6.2] runs leave a verifiable event chain and an OTel-shaped trace without captured content', async () => {
  const { ex, store, run } = await runWith({ builder: 'honest' });
  try {
    assert.deepEqual(verifyEvents(store, run.id), { ok: true, events: verifyEvents(store, run.id).events });
    const spans = readTrace(store, run.id);
    const kinds = new Set(spans.map((s) => s.kind));
    for (const k of ['invoke_workflow', 'invoke_agent', 'execute_tool', 'gate']) assert.ok(kinds.has(k), `missing ${k} span`);
    const agent = spans.find((s) => s.kind === 'invoke_agent' && s.attributes['gen_ai.agent.name'] === 'builder');
    assert.equal(agent.attributes['gen_ai.usage.input_tokens'], 1000);
    assert.ok(!JSON.stringify(spans).includes('Start by reading'), 'prompt content must not be captured by default');
  } finally { ex.cleanup(); }
});

test('[P6.2] tampering with the event log is detected', async () => {
  const { ex, store, run } = await runWith({ builder: 'honest' });
  try {
    const file = path.join(runDir(store, run.id), 'events.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const e = JSON.parse(lines[1]); e.data.reason = 'edited'; lines[1] = JSON.stringify(e);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(verifyEvents(store, run.id).ok, false);
  } finally { ex.cleanup(); }
});

test('[P2.4][P4.1] the reviewer gets a refute brief and the diff, never the builder narrative', async () => {
  const { ex, store, run } = await runWith({ builder: 'honest' });
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(runDir(store, run.id), 'policy-reviewer.json'), 'utf8'));
    assert.deepEqual(policy.bashAllow, []);
    const ws = path.join(runDir(store, run.id), 'ws');
    assert.ok(fs.existsSync(path.join(ws, '.factory', 'review', 'diff.patch')));
    assert.ok(!fs.readFileSync(path.join(ws, '.factory', 'review', 'diff.patch'), 'utf8').includes('visible tests pass'));
  } finally { ex.cleanup(); }
});

test('[P7.2] nothing reaches the target branch before release', async () => {
  const { ex, run } = await runWith({ builder: 'honest' });
  try {
    assert.equal(fs.readFileSync(path.join(ex.target, 'slug.mjs'), 'utf8').includes('not implemented'), true);
    assert.equal(git(ex.target, ['branch', '--list', 'factory/*']), '');
    assert.equal(run.state, 'awaiting-release-approval');
  } finally { ex.cleanup(); }
});
