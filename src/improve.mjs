// Measured, supervised self-improvement in a separate loop (principle 9.1).
// intake → registered experiment (frozen task splits, held-out audit) → results linked from real runs → assessment
// → a proposal a human may approve. The loop cannot change graders or boundaries, and never edits control itself.
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, ensureDir, nowIso, readJson, sha256, writeJsonAtomic } from './util.mjs';
import { listRuns, loadRun } from './store.mjs';
import { assertHuman } from './approvals.mjs';

// Only these factory.json paths may be changed by an experiment.
export const ALLOWED_CHANGES = ['agent.model', 'agent.reviewModel', 'budgets.maxAttempts', 'context.mapMaxLines', 'roles.builder.model', 'roles.planner.model'];

const expDir = (store) => ensureDir(path.join(store.dir, 'improve', 'experiments'));
const expFile = (store, id) => path.join(expDir(store), `${id}.json`);
const ACCEPTED = new Set(['released', 'awaiting-release-approval', 'accepted']);

export function intake(store) {
  const records = [];
  for (const r of listRuns(store)) {
    if (ACCEPTED.has(r.state) || ['created', 'building', 'gating', 'reviewing', 'planning'].includes(r.state)) continue;
    const firstFail = (r.attempts ?? []).flatMap((a) => a.gates ?? []).find((g) => g.verdict !== 'PASS');
    const category = r.state === 'refused' ? 'spec-or-config'
      : r.state === 'budget-exhausted' ? 'budget'
      : firstFail?.verdict === 'NOT-EARNED' ? 'evaluator-or-infra'
      : firstFail ? 'implementation' : 'other';
    records.push({ runId: r.id, task: r.taskId, state: r.state, category, gate: firstFail?.id ?? null, reason: r.reason ?? null, configDigest: r.configDigest ?? null });
  }
  const summary = records.reduce((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {});
  writeJsonAtomic(path.join(store.dir, 'improve', 'intake.json'), { at: nowIso(), summary, records });
  return { summary, records };
}

export function registerExperiment(store, exp, by, policy) {
  assertHuman(by, policy);
  for (const key of ['id', 'hypothesis', 'baselineDigest', 'candidateDigest', 'change', 'selection', 'audit', 'minGain']) {
    if (!(key in exp)) throw new FactoryError('EXPERIMENT', `experiment needs ${key}`);
  }
  const forbidden = Object.keys(exp.change).filter((k) => !ALLOWED_CHANGES.includes(k));
  if (forbidden.length) {
    throw new FactoryError('EXPERIMENT', `the improvement loop may not change ${forbidden.join(', ')}: graders, holdouts, policy, roles and autonomy stay under separate human control`);
  }
  if (!exp.selection.length || !exp.audit.length) throw new FactoryError('EXPERIMENT', 'selection and audit task sets must both be non-empty');
  const overlap = exp.selection.filter((t) => exp.audit.includes(t));
  if (overlap.length) throw new FactoryError('EXPERIMENT', `audit tasks must be held out from selection; overlap: ${overlap.join(', ')}`);
  if (fs.existsSync(expFile(store, exp.id))) throw new FactoryError('EXPERIMENT', `experiment ${exp.id} is already registered; registrations are immutable`);
  const record = { ...exp, registeredBy: by, registeredAt: nowIso(), digest: sha256(JSON.stringify(exp)), results: [], selectionAssessedAt: null };
  writeJsonAtomic(expFile(store, exp.id), record);
  return record;
}

// Results come from real runs in the store, matched to an arm by the run's config digest — not from typed-in numbers.
export function recordResult(store, expId, runId) {
  const exp = readJson(expFile(store, expId));
  const run = loadRun(store, runId);
  const arm = run.configDigest === exp.baselineDigest ? 'baseline' : run.configDigest === exp.candidateDigest ? 'candidate' : null;
  if (!arm) throw new FactoryError('EXPERIMENT', `run ${runId} used config ${run.configDigest?.slice(0, 12)}, which is neither arm of ${expId}`);
  const split = exp.selection.includes(run.taskId) ? 'selection' : exp.audit.includes(run.taskId) ? 'audit' : null;
  if (!split) throw new FactoryError('EXPERIMENT', `task ${run.taskId} is not part of ${expId}`);
  if (split === 'audit' && !exp.selectionAssessedAt) throw new FactoryError('EXPERIMENT', 'audit results may only be recorded after the selection split was assessed');
  if (split === 'audit' && Date.parse(run.createdAt) < Date.parse(exp.selectionAssessedAt)) {
    throw new FactoryError('EXPERIMENT', 'this audit run started before selection was assessed; held-out tasks must be run after');
  }
  if (exp.results.some((r) => r.task === run.taskId && r.arm === arm)) throw new FactoryError('EXPERIMENT', `a ${arm} result for ${run.taskId} is already recorded`);
  exp.results.push({ runId, task: run.taskId, arm, split, accepted: ACCEPTED.has(run.state), at: nowIso() });
  writeJsonAtomic(expFile(store, expId), exp);
  return exp;
}

function splitOutcome(exp, split) {
  const tasks = exp[split];
  const rate = (arm) => {
    const rows = exp.results.filter((r) => r.split === split && r.arm === arm);
    if (rows.length !== tasks.length) return null;
    return rows.filter((r) => r.accepted).length / tasks.length;
  };
  const base = rate('baseline');
  const cand = rate('candidate');
  if (base === null || cand === null) return { complete: false };
  const regressions = tasks.filter((t) => exp.results.find((r) => r.task === t && r.arm === 'baseline')?.accepted && !exp.results.find((r) => r.task === t && r.arm === 'candidate')?.accepted);
  return { complete: true, baseline: base, candidate: cand, gain: cand - base, regressions };
}

export function assess(store, expId) {
  const exp = readJson(expFile(store, expId));
  const sel = splitOutcome(exp, 'selection');
  if (!sel.complete) return { decision: 'incomplete', detail: 'every selection task needs one baseline and one candidate run' };
  if (!exp.selectionAssessedAt) { exp.selectionAssessedAt = nowIso(); writeJsonAtomic(expFile(store, expId), exp); }
  if (sel.gain < exp.minGain || sel.regressions.length) {
    const decision = sel.gain < 0 || sel.regressions.length ? 'regressed' : 'inconclusive';
    return { decision, stage: 'selection', ...sel };
  }
  const audit = splitOutcome(exp, 'audit');
  if (!audit.complete) return { decision: 'shortlisted', stage: 'selection', ...sel, detail: 'selection improved; run the held-out audit tasks for both arms' };
  const decision = audit.gain >= exp.minGain && !audit.regressions.length ? 'improved' : audit.gain < 0 || audit.regressions.length ? 'regressed' : 'inconclusive';
  return {
    decision, stage: 'audit', selection: sel, audit,
    proposal: decision === 'improved' ? { candidateDigest: exp.candidateDigest, change: exp.change, next: `review the candidate control directory, then: factory approve config --as <name>` } : null,
  };
}
