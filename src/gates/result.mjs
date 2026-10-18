// Gate result contract (principle 4.3): three outcomes, evidence attached, missing evidence never counts as a pass.
export const PASS = 'PASS';
export const NOT_EARNED = 'NOT-EARNED';
export const FAIL = 'FAIL';
const VERDICTS = new Set([PASS, NOT_EARNED, FAIL]);

// `feedback` is what the builder may see on a retry; it defaults to the summary and remediation.
// Holdout gates override it with counts only (principle 4.2).
export function gateResult({ id, verdict, summary, remediation = null, evidence = {}, durationMs = 0, feedback, costUsd = 0 }) {
  if (!id) throw new TypeError('gate result needs an id');
  if (!VERDICTS.has(verdict)) throw new TypeError(`invalid verdict for ${id}: ${verdict}`);
  if (!summary) throw new TypeError(`gate ${id} needs a summary`);
  return {
    id, verdict, summary, remediation, evidence, durationMs, costUsd,
    feedback: feedback ?? { summary, remediation },
  };
}

// Overall verdict: FAIL wins, then NOT-EARNED; PASS only when every gate passed. No gates means nothing was verified.
export function combine(results) {
  if (!results.length) return NOT_EARNED;
  if (results.some((r) => r.verdict === FAIL)) return FAIL;
  if (results.some((r) => r.verdict === NOT_EARNED)) return NOT_EARNED;
  return PASS;
}
