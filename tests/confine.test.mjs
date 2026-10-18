// Confinement of code the agent wrote: Node's permission model around the profile's commands and the holdout evaluator
// (principles 4.2, 5.2, 7.3).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confineArgv, confineCommand, confineEvaluator, confineProfile, probeConfinement } from '../src/confine.mjs';
import { loadConfig, loadProfile } from '../src/config.mjs';
import { holdoutGate } from '../src/gates/holdout.mjs';
import { setupExample } from '../scripts/example.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONTROL = path.join(here, '..', 'examples', 'slug', 'control');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const CONFINED = 'node --permission --allow-fs-read=. --allow-fs-write=. --no-experimental-sqlite';

test('[P5.2] the node profile confines its test command, its allowlist and its observe commands', () => {
  const profile = confineProfile({ ...loadProfile('node', EXAMPLE_CONTROL), observe: { 'sample outputs': 'node demo.mjs' } });
  assert.equal(profile.commands.test.argv.join(' '), `${CONFINED} --experimental-test-isolation=none --test --test-reporter=tap`);
  assert.deepEqual(profile.bashAllow, [`${CONFINED} --experimental-test-isolation=none --test`]);
  assert.equal(profile.observe['sample outputs'], `${CONFINED} demo.mjs`);
  assert.equal(profile.confined, true);
});

test('[P5.2] a command the profile cannot confine, or one that would widen its own grant, is refused rather than run unconfined', () => {
  assert.throws(() => confineCommand('npm start'), /only node commands can be confined/);
  for (const command of ['node --allow-fs-read=* app.mjs', 'node --allow-child-process --test', 'node --experimental-sqlite app.mjs', 'node --test-isolation=process --test',
    'node --env-file=.env app.mjs', 'node --experimental-default-config-file app.mjs']) {
    assert.throws(() => confineCommand(command), /undo its confinement/, command);
  }
  const control = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-confine-'));
  made.push(control);
  fs.cpSync(EXAMPLE_CONTROL, control, { recursive: true });
  const f = path.join(control, 'factory.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), observe: { app: 'npm start' } }));
  assert.throws(() => loadConfig(control), /only node commands can be confined: npm start/);
});

test('[P5.2] on this machine\'s Node, confined code cannot read, write or link outside the workspace, start a process or load node:sqlite', async () => {
  const probe = await probeConfinement();
  assert.equal(probe.ok, true, probe.problems.join('; '));
  assert.equal(probe.result.workspace, 'allowed', 'the workspace itself stays readable and writable');
});

test('[P5.2] an option appended to the confined command widens its grant, which is why the hook lets only file paths follow it', async () => {
  const widened = await probeConfinement({ argv: [...confineArgv(['node']), '--allow-fs-read=*', 'probe.mjs'] });
  assert.equal(widened.result.read, 'allowed');
  assert.equal(widened.ok, false);
  assert.match(widened.problems.join('; '), /reading outside the workspace was allowed/);
});

test('[P5.2] the holdout evaluator may read only its own directory and the workspace, by real path, and write nothing', () => {
  const evaluator = path.join(EXAMPLE_CONTROL, 'evaluators', 'slug-holdout.mjs');
  const real = (p) => fs.realpathSync.native(p);
  assert.deepEqual(confineEvaluator({ evaluator, ws: here }), ['node', '--permission', `--allow-fs-read=${real(path.dirname(evaluator))}`,
    `--allow-fs-read=${real(here)}`, '--no-experimental-sqlite', real(evaluator)]);
});

test('[P4.2][P5.2] an evaluator outside control/evaluators is refused: its directory is what the candidate may read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-confine-'));
  made.push(dir);
  const control = path.join(dir, 'control');
  fs.cpSync(EXAMPLE_CONTROL, control, { recursive: true });
  // Run from the control directory itself, the evaluator would hand the candidate the holdouts next to it.
  fs.copyFileSync(path.join(control, 'evaluators', 'slug-holdout.mjs'), path.join(control, 'slug-holdout.mjs'));
  const f = path.join(control, 'holdouts', 'set-a.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), evaluator: '../slug-holdout.mjs' }));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const result = await holdoutGate({ config: loadConfig(control), task: { holdouts: ['set-a'] }, ws, store: { holdouts: path.join(dir, 'holdouts.json') },
    changedContents: {} });
  assert.equal(result.verdict, 'NOT-EARNED');
  assert.match(result.evidence.sets[0].summary, /must be a file under control\/evaluators, not \.\.\/slug-holdout\.mjs/);
});

test('[P7.3] doctor proves the confinement on this machine before any agent runs', async () => {
  const ex = await setupExample();
  try {
    const check = ex.readiness.checks.find((c) => c.id === 'confinement');
    assert.equal(check?.ok, true, check?.detail);
    assert.equal(ex.readiness.ok, true);
  } finally { ex.cleanup(); }
});
