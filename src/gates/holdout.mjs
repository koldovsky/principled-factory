// Holdout gate (principle 4.2): scenarios the builder never sees, run by a separate process outside the workspace,
// reported back to the builder as counts only. A set whose inputs appear in the candidate is retired. With a confined
// profile the evaluator runs under Node's permission model: it and the candidate it imports may read the workspace and the
// evaluator's directory, and write nothing (src/confine.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAIL, NOT_EARNED, PASS, gateResult } from './result.mjs';
import { confineEvaluator } from '../confine.mjs';
import { findLeaks, loadSet, retireSet, setStatus } from '../holdouts.mjs';
import { isInside, runProcess, scrubEnv } from '../util.mjs';

export async function holdoutGate({ config, task, ws, store, changedContents, shouldStop }) {
  const opts = { requireSealed: config.factory.holdouts?.requireSealed ?? false, keyEnv: config.factory.holdouts?.keyEnv ?? 'FACTORY_HOLDOUT_KEY' };
  const sets = [];
  const started = Date.now();
  if (!task.holdouts.length) return gateResult({ id: 'holdouts', verdict: NOT_EARNED, summary: 'the task has no holdout set' });
  for (const id of task.holdouts) {
    if (setStatus(store, id).status === 'retired') {
      sets.push({ id, verdict: NOT_EARNED, summary: `set ${id} is retired (its contents leaked); add a fresh set`, passed: 0, total: 0 });
      continue;
    }
    const { set, digest } = loadSet(config.controlDir, id, opts);
    const leaks = findLeaks(set, changedContents);
    if (leaks.length) {
      retireSet(store, id, `scenario inputs found in candidate files: ${leaks.map((l) => `${l.scenario}@${l.file}`).join(', ')}`);
      sets.push({ id, digest, verdict: FAIL, summary: `holdout content appeared in the candidate; set ${id} retired`, passed: 0, total: set.scenarios.length, leaks });
      continue;
    }
    const evaluators = path.join(config.controlDir, 'evaluators');
    const evaluator = path.join(evaluators, set.evaluator);
    // Confined, the candidate may read the evaluator's directory, so that must never be the control directory or the holdouts.
    if (!fs.existsSync(evaluator) || !isInside(path.dirname(evaluator), evaluators)) {
      sets.push({ id, digest, verdict: NOT_EARNED, summary: `evaluator for ${id} must be a file under control/evaluators, not ${set.evaluator}`, passed: 0,
        total: set.scenarios.length });
      continue;
    }
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-holdout-')));
    try {
      const candidate = fs.realpathSync.native(ws);
      const [command, ...args] = config.profile.confined ? confineEvaluator({ evaluator, ws: candidate }) : ['node', evaluator];
      const res = await runProcess({ command, args, cwd: scratch, stdin: JSON.stringify(set.scenarios),
        env: scrubEnv({ FACTORY_CANDIDATE_DIR: candidate }), timeoutMs: set.timeoutMs ?? 120_000, shouldStop });
      // Kept as evidence whatever the outcome, and never shown to the builder: a denial inside the evaluator shows up here.
      const stderr = res.stderr ? { stderr: res.stderr.slice(0, 2000) } : {};
      let out = null;
      try { out = JSON.parse(res.stdout.trim().split('\n').pop()); } catch { /* handled below */ }
      const ids = set.scenarios.map((s) => s.id).sort().join('|');
      const got = (out?.cases ?? []).map((c) => c.id).sort().join('|');
      if (!out || got !== ids) {
        sets.push({ id, digest, verdict: NOT_EARNED, summary: `evaluator for ${id} did not report every scenario exactly once`, passed: 0, total: set.scenarios.length,
          ...stderr });
        continue;
      }
      const passed = out.cases.filter((c) => c.passed === true).length;
      sets.push({ id, digest, verdict: passed === set.scenarios.length ? PASS : FAIL, summary: `${passed}/${set.scenarios.length}`, passed,
        total: set.scenarios.length, cases: out.cases, ...stderr });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const verdict = sets.some((s) => s.verdict === FAIL) ? FAIL : sets.some((s) => s.verdict === NOT_EARNED) ? NOT_EARNED : PASS;
  const passed = sets.reduce((n, s) => n + s.passed, 0);
  const total = sets.reduce((n, s) => n + s.total, 0);
  return gateResult({
    id: 'holdouts', verdict, durationMs: Date.now() - started,
    summary: `${passed}/${total} hidden scenario(s) passed${sets.some((s) => s.leaks) ? '; leaked set retired' : ''}`,
    evidence: { sets, passed, total },
    // The builder learns counts only: never scenario ids, inputs, expectations or actual values.
    feedback: { summary: `Hidden acceptance scenarios: ${passed} of ${total} passed. Their contents are not shown; make the change satisfy the stated rules in general, not specific examples.` },
  });
}
