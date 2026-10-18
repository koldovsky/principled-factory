// Adversarial review (principles 4.1, 4.4): a reviewer in a fresh context, read-only, told to refute the change.
// It sees the requirements, the diff and the code — never the builder's own account. Findings must cite a real
// file and line or they are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { FAIL, NOT_EARNED, PASS, gateResult } from './result.mjs';
import { FACTORY_DIR } from '../workspace.mjs';

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function validateFindings(raw, ws) {
  const valid = [];
  const dropped = [];
  for (const f of raw?.findings ?? []) {
    const abs = f.file ? path.join(ws, f.file) : null;
    const lines = abs && fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8').split('\n').length : 0;
    if (!lines || !Number.isInteger(f.line) || f.line < 1 || f.line > lines || !f.claim) dropped.push({ ...f, why: 'no real file:line evidence' });
    else valid.push(f);
  }
  return { valid, dropped };
}

export function writeReviewInputs(ws, patch) {
  const dir = path.join(ws, FACTORY_DIR, 'review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diff.patch'), patch);
}

export function judgeReview(agentResult, ws) {
  if (agentResult.status !== 'completed') {
    return gateResult({ id: 'review', verdict: NOT_EARNED, summary: `reviewer did not complete (${agentResult.status})`, costUsd: agentResult.costUsd ?? 0 });
  }
  const raw = extractJson(agentResult.resultText ?? '');
  if (!raw || !Array.isArray(raw.findings)) {
    return gateResult({ id: 'review', verdict: NOT_EARNED, summary: 'reviewer output was not the required JSON, so nothing was verified', costUsd: agentResult.costUsd ?? 0 });
  }
  const { valid, dropped } = validateFindings(raw, ws);
  const blocking = valid.filter((f) => f.severity === 'high');
  const evidence = { findings: valid, dropped };
  if (blocking.length) {
    return gateResult({ id: 'review', verdict: FAIL, summary: `${blocking.length} blocking review finding(s)`, evidence, costUsd: agentResult.costUsd ?? 0,
      remediation: blocking.map((f) => `${f.file}:${f.line} (${f.requirement ?? '-'}): ${f.claim}`).join('\n') });
  }
  return gateResult({ id: 'review', verdict: PASS, summary: `reviewer could not refute the change (${valid.length} non-blocking note(s), ${dropped.length} unsupported finding(s) dropped)`,
    evidence, costUsd: agentResult.costUsd ?? 0 });
}
