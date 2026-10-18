// Deterministic gates (principles 3.2, 4.1, 4.2, 4.3, 4.5, 8.1): integrity, diff budget, visible tests, repeat, baseline.
import fs from 'node:fs';
import path from 'node:path';
import { FAIL, NOT_EARNED, PASS, gateResult } from './result.mjs';
import { hashFile, listFiles, matchesAny, runProcess, scrubEnv } from '../util.mjs';

// --- TAP (node --test --test-reporter=tap) ---------------------------------------------------------------------
export function parseTap(text) {
  const tests = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(ok|not ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i);
    if (!m) continue;
    const test = { name: m[3].trim(), ok: m[2] === 'ok', skipped: Boolean(m[4]), depth: m[1].length };
    if (!test.ok) {
      const diag = [];
      for (let j = i + 1; j < lines.length && diag.length < 30; j++) {
        if (/^\s*(ok|not ok) \d+ - /.test(lines[j]) || /^\s*# Subtest:/.test(lines[j])) break;
        diag.push(lines[j].trim());
      }
      test.diagnostics = diag.filter((l) => l && l !== '---' && l !== '...').join('\n');
    }
    tests.push(test);
  }
  return tests;
}

export async function runTestCommand({ ws, profile, shouldStop }) {
  const cmd = profile.commands.test;
  const [command, ...args] = cmd.argv;
  const res = await runProcess({ command, args, cwd: ws, env: scrubEnv(), timeoutMs: cmd.timeoutMs ?? 300_000, shouldStop });
  const tests = cmd.parse === 'tap' ? parseTap(res.stdout) : [];
  return { ...res, tests, parse: cmd.parse };
}

// Visible tests: every named test must run; any failure fails; nothing parsed means nothing was verified.
export function judgeVisible(run, task, id = 'visible-tests') {
  const required = [...task.visibleTests.failToPass, ...task.visibleTests.passToPass];
  const started = Date.now();
  if (run.parse !== 'tap') {
    if (required.length) return gateResult({ id, verdict: NOT_EARNED, summary: 'the profile cannot report named tests, so the required tests cannot be confirmed', durationMs: run.durationMs });
    return gateResult({ id, verdict: run.status === 'completed' ? PASS : FAIL, summary: `test command exited ${run.exitCode}`, durationMs: run.durationMs });
  }
  const byName = new Map(run.tests.filter((t) => !t.skipped).map((t) => [t.name, t]));
  const missing = required.filter((n) => !byName.has(n));
  const failing = [...byName.values()].filter((t) => !t.ok);
  const evidence = { tests: run.tests.map(({ name, ok, skipped }) => ({ name, ok, skipped })), exitCode: run.exitCode };
  if (!run.tests.length) return gateResult({ id, verdict: NOT_EARNED, summary: 'no test results were reported', evidence, durationMs: run.durationMs + (Date.now() - started) });
  if (missing.length) return gateResult({ id, verdict: NOT_EARNED, summary: `required tests did not run: ${missing.join(', ')}`, evidence, durationMs: run.durationMs,
    remediation: 'make sure the test files still load; the required tests must run and pass' });
  if (failing.length || run.status !== 'completed') {
    return gateResult({ id, verdict: FAIL, summary: `${failing.length} failing test(s): ${failing.map((t) => t.name).join(', ') || `exit ${run.exitCode}`}`,
      remediation: failing.map((t) => `${t.name}:\n${t.diagnostics ?? ''}`).join('\n\n').slice(0, 4000), evidence, durationMs: run.durationMs });
  }
  return gateResult({ id, verdict: PASS, summary: `${byName.size} visible test(s) passed`, evidence, durationMs: run.durationMs });
}

// Repeat: the same suite k more times must give identical outcomes (flaky tests can't be trusted as an oracle).
export async function repeatGate({ ws, profile, task, times, first, shouldStop }) {
  const signature = (tests) => tests.map((t) => `${t.name}:${t.ok}`).sort().join('|');
  const base = signature(first.tests);
  let durationMs = 0;
  for (let i = 0; i < times; i++) {
    const again = await runTestCommand({ ws, profile, shouldStop });
    durationMs += again.durationMs;
    if (signature(again.tests) !== base || judgeVisible(again, task).verdict !== PASS) {
      return gateResult({ id: 'repeat', verdict: FAIL, summary: `test outcomes changed on repeat ${i + 1}: the suite is flaky or order-dependent`,
        remediation: 'remove nondeterminism (time, randomness, shared state) from the code under test', durationMs, evidence: { repeat: i + 1 } });
    }
  }
  return gateResult({ id: 'repeat', verdict: PASS, summary: `outcomes identical across ${times + 1} runs`, durationMs, evidence: { runs: times + 1 } });
}

// Baseline (at admission): fail-to-pass tests must fail on the original code, pass-to-pass tests must pass.
export function judgeBaseline(run, task) {
  const byName = new Map(run.tests.map((t) => [t.name, t]));
  const problems = [];
  for (const n of task.visibleTests.failToPass) {
    const t = byName.get(n);
    if (t?.ok) problems.push(`visible test "${n}" already passes on the original code, so it cannot prove the change`);
  }
  for (const n of task.visibleTests.passToPass) {
    const t = byName.get(n);
    if (!t) problems.push(`pass-to-pass test "${n}" did not run on the original code`);
    else if (!t.ok) problems.push(`pass-to-pass test "${n}" already fails on the original code`);
  }
  return problems;
}

// Integrity (principle 4.2): protected files unchanged, nothing new written under protected paths.
export function integrityGate({ ws, manifest, globs }) {
  const started = Date.now();
  if (!Object.keys(manifest).length) {
    return gateResult({ id: 'integrity', verdict: NOT_EARNED, summary: 'no protected files were recorded, so test integrity cannot be confirmed' });
  }
  const problems = [];
  for (const [file, hash] of Object.entries(manifest)) {
    const abs = path.join(ws, file);
    if (!fs.existsSync(abs)) problems.push(`${file} was deleted`);
    else if (hashFile(abs) !== hash) problems.push(`${file} was modified`);
  }
  for (const file of listFiles(ws).filter((f) => matchesAny(f, globs))) {
    if (!(file in manifest)) problems.push(`${file} was added under a protected path`);
  }
  if (problems.length) {
    return gateResult({ id: 'integrity', verdict: FAIL, summary: `protected files changed: ${problems.join('; ')}`,
      remediation: 'restore the protected files; change the product code instead', evidence: { problems }, durationMs: Date.now() - started });
  }
  return gateResult({ id: 'integrity', verdict: PASS, summary: `${Object.keys(manifest).length} protected file(s) unchanged`, durationMs: Date.now() - started });
}

// Diff budget (principle 8.1): small changes stay reviewable; an empty change verifies nothing.
export function diffGate({ change, limit }) {
  if (!change.files.length) return gateResult({ id: 'diff', verdict: FAIL, summary: 'no change was made', remediation: 'implement the requirements in the product code' });
  if (change.linesChanged > limit) {
    return gateResult({ id: 'diff', verdict: FAIL, summary: `${change.linesChanged} changed lines exceed the ${limit}-line review budget`,
      remediation: 'make a smaller change: one thin slice that a person can review in minutes', evidence: { files: change.files } });
  }
  return gateResult({ id: 'diff', verdict: PASS, summary: `${change.files.length} file(s), ${change.linesChanged} changed lines`, evidence: { files: change.files } });
}
