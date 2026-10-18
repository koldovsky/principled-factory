// Unit tests for mechanisms that do not need a full run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTrifecta, loadConfig, configDigest, loadProfile } from '../src/config.mjs';
import { gc } from '../src/gc.mjs';
import { openStore, createRun, loadRun, transition, acquireLock, saveRun } from '../src/store.mjs';
import { recordApproval, releaseApprovalStatus, assertReleaseApprover, isApproved } from '../src/approvals.mjs';
import { sealSet, openSealed, findLeaks, loadSet, sealFile } from '../src/holdouts.mjs';
import { judgeReview, validateFindings } from '../src/gates/review.mjs';
import { classify, effectiveTier, recordRelease, recordIncident } from '../src/autonomy.mjs';
import { buildMap, writeContextPack } from '../src/context.mjs';
import { registerExperiment, recordResult, assess, ALLOWED_CHANGES } from '../src/improve.mjs';
import { evaluate, tagsOf } from '../src/conformance.mjs';
import { combine, gateResult } from '../src/gates/result.mjs';
import { parseTap, judgeVisible, judgeBaseline, integrityGate, diffGate } from '../src/gates/deterministic.mjs';
import { validate } from '../src/schema.mjs';
import { boundaryEvidence } from '../src/gates/boundary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONTROL = path.join(here, '..', 'examples', 'slug', 'control');
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-unit-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const copyControl = () => { const d = path.join(tmp(), 'control'); fs.cpSync(EXAMPLE_CONTROL, d, { recursive: true }); return d; };
const role = (privateData, untrustedContent, externalComms, tools = ['Read']) => ({ capabilities: { privateData, untrustedContent, externalComms }, tools });

// --- 5.1 trifecta ---------------------------------------------------------------------------------------------
test('[P5.1] a role holding private data, untrusted content and external communication is refused', () => {
  assert.throws(() => checkTrifecta({ builder: role(true, true, true, ['Read', 'WebFetch']) }), /lethal trifecta/);
  assert.doesNotThrow(() => checkTrifecta({ builder: role(true, true, false), researcher: role(false, true, true, ['WebFetch']) }));
});

test('[P5.1] a role without external communication may not list network tools', () => {
  assert.throws(() => checkTrifecta({ builder: role(true, true, false, ['WebFetch']) }), /network tools/);
});

test('[P5.1][mechanism-off] with the trifecta check skipped, the dangerous configuration loads', () => {
  const control = copyControl();
  const f = JSON.parse(fs.readFileSync(path.join(control, 'factory.json'), 'utf8'));
  f.roles.builder.capabilities.externalComms = true;
  fs.writeFileSync(path.join(control, 'factory.json'), JSON.stringify(f));
  assert.throws(() => loadConfig(control), /lethal trifecta/);
  assert.doesNotThrow(() => loadConfig(control, { skipTrifecta: true }));
});

// --- 8.3 policy, 5.4 config digest -------------------------------------------------------------------------------
test('[P8.3] roles may only use tools the AI policy approves', () => {
  const control = copyControl();
  const p = JSON.parse(fs.readFileSync(path.join(control, 'policy.json'), 'utf8'));
  p.approvedTools = ['Read'];
  fs.writeFileSync(path.join(control, 'policy.json'), JSON.stringify(p));
  assert.throws(() => loadConfig(control), /not in the AI policy/);
});

test('[P5.4] the config digest changes when any policy-bearing file changes, and not for tasks', () => {
  const control = copyControl();
  const before = loadConfig(control).digest;
  fs.appendFileSync(path.join(control, 'tasks', 'slug.json'), '\n');
  assert.equal(loadConfig(control).digest, before);
  fs.appendFileSync(path.join(control, 'knowledge', 'slugs.md'), '\n- new rule\n');
  assert.notEqual(loadConfig(control).digest, before);
  const again = loadConfig(control).digest;
  fs.appendFileSync(path.join(control, 'evaluators', 'slug-holdout.mjs'), '\n// changed\n');
  assert.notEqual(configDigest(control, loadConfig(control).profile.file), again);
});

// --- 5.3 separation of duties, 1.1 / 8.2 approvals ----------------------------------------------------------------
test('[P5.3] agent identities cannot approve anything', () => {
  const store = openStore(tmp());
  for (const by of ['agent:builder', 'claude', 'codex-bot', 'copilot']) {
    assert.throws(() => recordApproval(store, { kind: 'config', subject: 'factory', digest: 'd', by }), /agent/);
  }
  assert.throws(() => recordApproval(store, { kind: 'config', subject: 'factory', digest: 'd', by: '' }), /identity/);
});

test('[P5.3][mechanism-off] without the identity check an agent approval would be recorded', () => {
  const store = openStore(tmp());
  recordApproval(store, { kind: 'config', subject: 'factory', digest: 'd', by: 'agent:builder' }, null, { unsafeSkipIdentity: true });
  assert.equal(isApproved(store, 'config', 'factory', 'd'), true);
});

test('[P5.3][P8.2] release approvals must come from someone other than the requester and cite the current proof pack', () => {
  const run = { id: 'r', requestedBy: 'alice', proofDigest: 'p1' };
  assert.throws(() => assertReleaseApprover(run, 'alice', 'p1'), /requested this run/);
  assert.throws(() => assertReleaseApprover(run, 'bob', 'old'), /current proof pack/);
  assert.doesNotThrow(() => assertReleaseApprover(run, 'bob', 'p1'));
});

test('[P5.3][P7.1] two-human tiers need two distinct approvers; stale-proof approvals do not count', () => {
  const store = openStore(tmp());
  const run = { id: 'r1', requestedBy: 'alice', proofDigest: 'p2' };
  recordApproval(store, { kind: 'release', subject: 'r1', digest: 'p2', by: 'bob' });
  recordApproval(store, { kind: 'release', subject: 'r1', digest: 'p2', by: 'bob' });
  recordApproval(store, { kind: 'release', subject: 'r1', digest: 'p-old', by: 'carol' });
  assert.equal(releaseApprovalStatus(store, run, 'two-humans').satisfied, false);
  recordApproval(store, { kind: 'release', subject: 'r1', digest: 'p2', by: 'carol' });
  assert.deepEqual(releaseApprovalStatus(store, run, 'two-humans'), { needed: 2, have: 2, approvers: ['bob', 'carol'], satisfied: true });
});

test('[P8.3] when the policy lists approvers, others cannot approve', () => {
  const store = openStore(tmp());
  assert.throws(() => recordApproval(store, { kind: 'config', subject: 'factory', digest: 'd', by: 'mallory' }, { approvers: ['alice'] }), /approver list/);
});

// --- 2.3 store ------------------------------------------------------------------------------------------------
test('[P2.3] runs move only through allowed transitions, and a stale lock needs explicit recovery', () => {
  const store = openStore(tmp());
  const run = createRun(store, { taskId: 't', requestedBy: 'alice' });
  assert.throws(() => transition(store, run, 'released'), /not allowed/);
  fs.writeFileSync(path.join(store.runsDir, run.id, 'lock'), JSON.stringify({ pid: 999999 }));
  assert.throws(() => acquireLock(store, run.id), /stale lock/);
  const unlock = acquireLock(store, run.id, { recover: true });
  unlock();
  assert.equal(loadRun(store, run.id).state, 'created');
});

// --- 4.2 holdouts ------------------------------------------------------------------------------------------------
test('[P4.2] sealed holdouts round-trip only with the right key and reveal nothing on disk', () => {
  const set = { scenarios: [{ id: 'A1', input: 'Ready, Set, Go', expect: 'ready-set-go' }] };
  const sealed = sealSet(set, 'correct horse battery staple');
  assert.ok(!JSON.stringify(sealed).includes('Ready'));
  assert.deepEqual(openSealed(sealed, 'correct horse battery staple'), set);
  assert.throws(() => openSealed(sealed, 'wrong key, sixteen+'), /wrong key/);
});

test('[P4.2] plaintext holdouts are refused when sealing is required; sealing removes the plaintext', () => {
  const control = copyControl();
  assert.throws(() => loadSet(control, 'set-a', { requireSealed: true }), /plaintext/);
  process.env.PF_TEST_KEY = 'a-test-key-that-is-long-enough';
  sealFile(control, 'set-a', { keyEnv: 'PF_TEST_KEY' });
  assert.equal(fs.existsSync(path.join(control, 'holdouts', 'set-a.json')), false);
  assert.equal(loadSet(control, 'set-a', { requireSealed: true, keyEnv: 'PF_TEST_KEY' }).set.scenarios.length, 8);
});

test('[P4.2] holdout inputs appearing in candidate files are detected as a leak', () => {
  const set = { scenarios: [{ id: 'A1', input: 'Ready, Set, Go' }, { id: 'A6', input: 42 }] };
  assert.deepEqual(findLeaks(set, { 'slug.mjs': "if (text === 'Ready, Set, Go') return 'x';" }), [{ scenario: 'A1', file: 'slug.mjs' }]);
  assert.deepEqual(findLeaks(set, { 'slug.mjs': 'return text.trim();' }), []);
});

// --- 4.3 results ---------------------------------------------------------------------------------------------------
test('[P4.3] the combined verdict fails closed: no gates, or any NOT-EARNED, is not a pass', () => {
  const r = (verdict) => gateResult({ id: 'g', verdict, summary: 's' });
  assert.equal(combine([]), 'NOT-EARNED');
  assert.equal(combine([r('PASS'), r('NOT-EARNED')]), 'NOT-EARNED');
  assert.equal(combine([r('PASS'), r('FAIL'), r('NOT-EARNED')]), 'FAIL');
  assert.equal(combine([r('PASS')]), 'PASS');
  assert.throws(() => gateResult({ id: 'g', verdict: 'OK', summary: 's' }), /invalid verdict/);
});

test('[P4.3] visible tests: missing required tests are NOT-EARNED, nothing parsed is NOT-EARNED, a failure is FAIL', () => {
  const task = { visibleTests: { failToPass: ['a'], passToPass: ['b'] } };
  const tap = (lines) => ({ parse: 'tap', status: 'completed', exitCode: 0, durationMs: 1, tests: parseTap(lines.join('\n')) });
  assert.equal(judgeVisible(tap(['ok 1 - a']), task).verdict, 'NOT-EARNED');
  assert.equal(judgeVisible(tap([]), task).verdict, 'NOT-EARNED');
  assert.equal(judgeVisible({ ...tap(['ok 1 - a', 'not ok 2 - b', '  ---', '  error: boom', '  ...']), status: 'failed', exitCode: 1 }, task).verdict, 'FAIL');
  assert.equal(judgeVisible(tap(['ok 1 - a', 'ok 2 - b']), task).verdict, 'PASS');
});

test('[P4.5] baseline: a fail-to-pass test that already passes on the original code is rejected', () => {
  const task = { visibleTests: { failToPass: ['a'], passToPass: ['b'] } };
  assert.deepEqual(judgeBaseline({ tests: parseTap('not ok 1 - a\nok 2 - b') }, task), []);
  assert.match(judgeBaseline({ tests: parseTap('ok 1 - a\nok 2 - b') }, task)[0], /cannot prove the change/);
});

test('[P4.2] integrity gate: modified, deleted and newly added protected files fail; no manifest is NOT-EARNED', () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, 'test'));
  fs.writeFileSync(path.join(ws, 'test', 'a.test.mjs'), 'x');
  const manifest = { 'test/a.test.mjs': '0'.repeat(64) };
  assert.equal(integrityGate({ ws, manifest, globs: ['test/**'] }).verdict, 'FAIL');
  assert.equal(integrityGate({ ws, manifest: {}, globs: ['test/**'] }).verdict, 'NOT-EARNED');
});

test('[P8.1] diff budget: oversized and empty changes fail', () => {
  assert.equal(diffGate({ change: { files: [{ file: 'a', added: 400, removed: 0 }], linesChanged: 400 }, limit: 300 }).verdict, 'FAIL');
  assert.equal(diffGate({ change: { files: [], linesChanged: 0 }, limit: 300 }).verdict, 'FAIL');
  assert.equal(diffGate({ change: { files: [{ file: 'a', added: 3, removed: 1 }], linesChanged: 4 }, limit: 300 }).verdict, 'PASS');
});

// --- 4.4 review ----------------------------------------------------------------------------------------------------
test('[P4.4] review: findings without real file:line evidence are dropped; high findings block; bad output is NOT-EARNED', () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, 'slug.mjs'), 'a\nb\nc\n');
  const ok = (findings) => ({ status: 'completed', costUsd: 0, resultText: JSON.stringify({ findings }) });
  assert.equal(validateFindings({ findings: [{ file: 'nope.mjs', line: 1, claim: 'x' }] }, ws).dropped.length, 1);
  assert.equal(judgeReview(ok([{ severity: 'high', file: 'slug.mjs', line: 2, claim: 'wrong' }]), ws).verdict, 'FAIL');
  assert.equal(judgeReview(ok([{ severity: 'high', file: 'slug.mjs', line: 99, claim: 'wrong' }]), ws).verdict, 'PASS');
  assert.equal(judgeReview({ status: 'completed', resultText: 'Looks good!' }, ws).verdict, 'NOT-EARNED');
  assert.equal(judgeReview({ status: 'failed', resultText: '' }, ws).verdict, 'NOT-EARNED');
});

// --- 7.1 autonomy --------------------------------------------------------------------------------------------------
const autonomy = { classes: [{ name: 'docs', paths: ['**/*.md'], tier: 'auto' }, { name: 'code', paths: ['**/*.mjs'], tier: 'one-human', earnable: true },
  { name: 'migration', paths: ['migrations/**'], tier: 'two-humans' }], default: 'one-human', promoteAfter: 2 };
const policy = { unattendedClasses: ['docs', 'code'] };

test('[P7.1] the most restrictive class touched by a change decides', () => {
  assert.equal(classify([{ file: 'README.md' }], autonomy).name, 'docs');
  assert.equal(classify([{ file: 'README.md' }, { file: 'slug.mjs' }], autonomy).name, 'code');
  assert.equal(classify([{ file: 'slug.mjs' }, { file: 'migrations/001.sql' }], autonomy).name, 'migration');
});

test('[P7.1] earnable classes gain a tier after clean releases; an incident demotes them', () => {
  const store = openStore(tmp());
  const code = autonomy.classes[1];
  assert.equal(effectiveTier(store, code, autonomy, policy).tier, 'one-human');
  recordRelease(store, 'code'); recordRelease(store, 'code');
  assert.equal(effectiveTier(store, code, autonomy, policy).tier, 'auto');
  recordIncident(store, 'code');
  assert.equal(effectiveTier(store, code, autonomy, policy).tier, 'two-humans');
});

test('[P7.1][P8.3] the AI policy keeps classes it does not list out of unattended work', () => {
  const store = openStore(tmp());
  assert.equal(effectiveTier(store, autonomy.classes[0], autonomy, { unattendedClasses: [] }).tier, 'one-human');
});

// --- 2.2 context ---------------------------------------------------------------------------------------------------
test('[P2.2] the always-loaded map must fit its line budget; knowledge is listed, not inlined', () => {
  const config = loadConfig(EXAMPLE_CONTROL);
  const task = JSON.parse(fs.readFileSync(path.join(EXAMPLE_CONTROL, 'tasks', 'slug.json'), 'utf8'));
  const map = buildMap({ config, task, profile: config.profile });
  assert.ok(map.some((l) => l.includes('.factory/knowledge/slugs.md')));
  assert.ok(!map.join('\n').includes('becomes «cest»'), 'knowledge content must not be inlined');
  const ws = tmp();
  assert.throws(() => writeContextPack({ ws, config: { ...config, factory: { ...config.factory, context: { mapMaxLines: 10 } } }, task, profile: config.profile }), /budget/);
  assert.equal(writeContextPack({ ws, config, task, profile: config.profile }).mapLines, map.length);
});

// --- 9.1 improvement loop ------------------------------------------------------------------------------------------
test('[P9.1] experiments may not touch graders, and audit tasks must be held out', () => {
  const store = openStore(tmp());
  const base = { id: 'e1', hypothesis: 'h', baselineDigest: 'b', candidateDigest: 'c', selection: ['t1'], audit: ['t2'], minGain: 0.2 };
  assert.throws(() => registerExperiment(store, { ...base, change: { 'gates.order': [] } }, 'alice'), /may not change gates.order/);
  assert.throws(() => registerExperiment(store, { ...base, change: { 'agent.model': 'x' }, audit: ['t1'] }, 'alice'), /held out/);
  assert.throws(() => registerExperiment(store, { ...base, change: { 'agent.model': 'x' } }, 'agent:optimizer'), /agent/);
  registerExperiment(store, { ...base, change: { 'agent.model': 'x' } }, 'alice');
  assert.throws(() => registerExperiment(store, { ...base, change: { 'agent.model': 'y' } }, 'alice'), /immutable/);
  assert.ok(ALLOWED_CHANGES.every((k) => !/gates|holdout|policy|autonomy|capabilities|tools/.test(k)));
});

test('[P9.1] results come from real runs matched by config digest; audit only after selection; decision is conservative', () => {
  const store = openStore(tmp());
  registerExperiment(store, { id: 'e2', hypothesis: 'h', baselineDigest: 'B', candidateDigest: 'C', change: { 'agent.model': 'x' }, selection: ['s1', 's2'], audit: ['a1'], minGain: 0.5 }, 'alice');
  const mk = (taskId, digest, state) => { const r = createRun(store, { taskId, requestedBy: 'alice', configDigest: digest }); r.state = state; saveRun(store, r); return r.id; };
  assert.throws(() => recordResult(store, 'e2', mk('s1', 'OTHER', 'released')), /neither arm/);
  recordResult(store, 'e2', mk('s1', 'B', 'needs-human'));
  recordResult(store, 'e2', mk('s1', 'C', 'released'));
  assert.equal(assess(store, 'e2').decision, 'incomplete');
  recordResult(store, 'e2', mk('s2', 'B', 'needs-human'));
  assert.throws(() => recordResult(store, 'e2', mk('a1', 'C', 'released')), /after the selection split/);
  recordResult(store, 'e2', mk('s2', 'C', 'released'));
  assert.equal(assess(store, 'e2').decision, 'shortlisted');
  recordResult(store, 'e2', mk('a1', 'B', 'needs-human'));
  recordResult(store, 'e2', mk('a1', 'C', 'released'));
  const final = assess(store, 'e2');
  assert.equal(final.decision, 'improved');
  assert.equal(final.proposal.candidateDigest, 'C');
});

// --- 9.3 conformance -----------------------------------------------------------------------------------------------
test('[P9.3] conformance flags principles without passing tests, with failing tests, or without required mechanism-off tests', () => {
  const registry = { principles: [{ id: '1.1', name: 'a', status: 'enforced' }, { id: '4.2', name: 'b', status: 'partial', requiresMechanismOff: true }, { id: '9.9', name: 'c', status: 'enforced' }] };
  const tests = [{ name: '[P1.1] x', ok: true }, { name: '[P4.2] y', ok: true }, { name: '[P1.1] z', ok: false }];
  const r = evaluate(registry, tests);
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows.map((x) => x.ok), [false, false, false]);
  assert.deepEqual(tagsOf('[P4.2][P5.2][mechanism-off] t'), { principles: ['4.2', '5.2'], mechanismOff: true });
});

test('[P9.3] the registry lists all 35 principles with an honest status', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(here, '..', 'docs', 'principles.json'), 'utf8'));
  assert.equal(reg.principles.length, 35);
  assert.equal(new Set(reg.principles.map((p) => p.id)).size, 35);
  for (const p of reg.principles) {
    assert.ok(['enforced', 'partial', 'documented'].includes(p.status), p.id);
    if (p.status !== 'enforced') assert.ok(p.limits, `${p.id} must state its limits`);
  }
});

test('[P9.2] gc turns maintainability findings and stale doc links into draft cleanup tasks that wait for a human', () => {
  const dir = tmp();
  const target = path.join(dir, 'target');
  fs.cpSync(path.join(here, '..', 'examples', 'slug', 'target'), target, { recursive: true });
  fs.appendFileSync(path.join(target, 'README.md'), '\nSee [the guide](docs/missing.md).\n');
  fs.writeFileSync(path.join(target, 'big.mjs'), Array.from({ length: 320 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
  const result = gc({ controlDir: copyControl(), targetDir: target, storeDir: path.join(dir, 'store') });
  const rules = result.proposals.map((p) => p.finding.rule);
  assert.ok(rules.includes('stale-doc-link'));
  assert.ok(rules.includes('max-file-lines'));
  for (const p of result.proposals) {
    assert.equal(p.status, 'draft');
    assert.ok(p.needs.some((n) => /intent approval by a human/.test(n)));
    assert.equal(p.task.requirements, undefined, 'a draft has no acceptance cases, so admission would refuse it');
  }
  assert.equal(fs.readdirSync(path.join(dir, 'store', 'gc', 'proposals')).length, result.proposals.length);
});

test('[P9.4] every built-in stack profile validates against the profile schema', () => {
  const names = fs.readdirSync(path.join(here, '..', 'profiles')).map((f) => f.replace(/\.json$/, ''));
  assert.ok(names.length >= 2);
  for (const name of names) assert.equal(loadProfile(name, copyControl()).name, name);
});

test('[P5.2][P9.4] the generic command adapter is refused unless the AI policy explicitly allows an unconfined agent', () => {
  const c = copyControl();
  const f = path.join(c, 'factory.json');
  const fac = JSON.parse(fs.readFileSync(f, 'utf8'));
  fac.agent = { adapter: 'command', model: 'external-cli', command: ['some-cli'] };
  fs.writeFileSync(f, JSON.stringify(fac));
  assert.throws(() => loadConfig(c), /allowUnconfinedAgent/);
});

test('[P4.3] a configuration that would skip a gate silently is refused: unknown gates, or review without a reviewer', () => {
  const c = copyControl();
  const f = path.join(c, 'factory.json');
  const fac = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...fac, gates: { ...fac.gates, order: [...fac.gates.order, 'securty-scan'] } }));
  assert.throws(() => loadConfig(c), /unknown gate/);
  const noReviewer = { ...fac, roles: { ...fac.roles } };
  delete noReviewer.roles.reviewer;
  fs.writeFileSync(f, JSON.stringify(noReviewer));
  assert.throws(() => loadConfig(c), /no reviewer role/);
});

test('[P4.3][P5.2] boundary evidence: changed files need an allowed write or command decided by the hook in that attempt', () => {
  const s = (tool, decision, attempt = 1, role = 'builder') => ({ kind: 'execute_tool', attributes: { 'gen_ai.tool.name': tool, 'factory.decision': decision, 'factory.attempt': attempt, 'gen_ai.agent.name': role } });
  assert.equal(boundaryEvidence({ spans: [], attempt: 1, changedFiles: 0 }).verdict, 'PASS', 'no change needs no evidence');
  assert.equal(boundaryEvidence({ spans: [s('Read', 'allow')], attempt: 1, changedFiles: 2 }).verdict, 'NOT-EARNED');
  assert.equal(boundaryEvidence({ spans: [s('Write', 'deny')], attempt: 1, changedFiles: 2 }).verdict, 'NOT-EARNED', 'a denied write changed nothing');
  assert.equal(boundaryEvidence({ spans: [s('Write', 'allow', 1)], attempt: 2, changedFiles: 2 }).verdict, 'NOT-EARNED', 'evidence from another attempt does not count');
  assert.equal(boundaryEvidence({ spans: [s('Write', 'allow', 1, 'reviewer')], attempt: 1, changedFiles: 2 }).verdict, 'NOT-EARNED', 'only the builder counts');
  const ok = boundaryEvidence({ spans: [s('Edit', 'allow'), s('Read', 'deny')], attempt: 1, changedFiles: 2 });
  assert.equal(ok.verdict, 'PASS');
  assert.deepEqual([ok.evidence.decided, ok.evidence.denied, ok.evidence.allowedChanges], [2, 1, 1]);
});

test('[P1.2] the task schema requires non-functionals and acceptance mapping', () => {
  const errors = validate({ a: 1 }, { type: 'object', required: ['nonFunctionals'] });
  assert.match(errors[0], /required/);
});
