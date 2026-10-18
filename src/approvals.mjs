// Human checkpoints and separation of duties (principles 1.1, 5.3, 8.1, 8.2, 8.3).
import { FactoryError, appendJsonLine, newId, nowIso, readJsonLines } from './util.mjs';
import { listRuns, WAITING_FOR_HUMANS } from './store.mjs';

export const KINDS = ['intent', 'plan', 'release', 'config', 'promotion'];

// Agents never approve anything; an identity must be a named human, and on the approver list when the policy has one.
export function assertHuman(identity, policy) {
  if (!identity || typeof identity !== 'string' || !identity.trim()) {
    throw new FactoryError('IDENTITY', 'an approval needs a named identity (--as <name>)');
  }
  if (/^agent[:/]/i.test(identity) || /\b(claude|codex|copilot|bot)\b/i.test(identity)) {
    throw new FactoryError('SEPARATION', `${identity} looks like an agent identity; agents cannot approve`);
  }
  if (policy?.approvers?.length && !policy.approvers.includes(identity)) {
    throw new FactoryError('SEPARATION', `${identity} is not on the AI policy's approver list`);
  }
}

// `unsafeSkipIdentity` exists only so a test can show the identity check is what stops agent approvals.
export function recordApproval(store, { kind, subject, digest, by, note = '' }, policy, { unsafeSkipIdentity = false } = {}) {
  if (!KINDS.includes(kind)) throw new FactoryError('APPROVAL', `unknown approval kind ${kind}`);
  if (!unsafeSkipIdentity) assertHuman(by, policy);
  if (!digest) throw new FactoryError('APPROVAL', 'an approval must name the exact digest it approves');
  const entry = { id: newId('appr'), kind, subject, digest, by, note, at: nowIso() };
  appendJsonLine(store.approvals, entry);
  return entry;
}

export function approvals(store, { kind, subject, digest } = {}) {
  return readJsonLines(store.approvals).filter((a) =>
    (!kind || a.kind === kind) && (!subject || a.subject === subject) && (!digest || a.digest === digest));
}

export function isApproved(store, kind, subject, digest) {
  return approvals(store, { kind, subject, digest }).length > 0;
}

// Release approvals bound to the proof pack the approver actually reviewed (8.2), from people other than the requester (5.3).
export function releaseApprovalStatus(store, run, tier) {
  const needed = tier === 'two-humans' ? 2 : tier === 'one-human' ? 1 : 0;
  const valid = approvals(store, { kind: 'release', subject: run.id })
    .filter((a) => a.digest === run.proofDigest && a.by !== run.requestedBy);
  const distinct = [...new Set(valid.map((a) => a.by))];
  return { needed, have: distinct.length, approvers: distinct, satisfied: distinct.length >= needed };
}

export function assertReleaseApprover(run, by, proofDigest) {
  if (by === run.requestedBy) throw new FactoryError('SEPARATION', `${by} requested this run and cannot approve its release`);
  if (proofDigest !== run.proofDigest) {
    throw new FactoryError('PROOF', `approval names proof ${String(proofDigest).slice(0, 12)}…, but the current proof pack is ${String(run.proofDigest).slice(0, 12)}…; review the current proof pack first`);
  }
}

// Review capacity (principle 8.1): items waiting for people, and the oldest wait.
export function reviewQueue(store) {
  const waiting = listRuns(store).filter((r) => WAITING_FOR_HUMANS.includes(r.state));
  const oldest = waiting.reduce((min, r) => Math.min(min, Date.parse(r.stateSince ?? r.updatedAt)), Infinity);
  return { wip: waiting.length, oldestWaitingMinutes: waiting.length ? Math.round((Date.now() - oldest) / 60000) : 0, runs: waiting.map((r) => r.id) };
}
