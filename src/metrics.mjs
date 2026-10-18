// Outcome, stability, cost and gate metrics from the store (principles 6.3, 6.4, 9.3).
import { readJsonLines } from './util.mjs';
import { listRuns, WAITING_FOR_HUMANS } from './store.mjs';
import { reviewQueue } from './approvals.mjs';
import { autonomyState } from './autonomy.mjs';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ratio = (a, b) => (b ? a / b : null);
const round = (n, d = 4) => (n === null || n === undefined ? null : Number(n.toFixed(d)));

export function computeMetrics(store, { config } = {}) {
  const runs = listRuns(store);
  const incidents = readJsonLines(store.incidents);
  const finished = runs.filter((r) => ['released', 'abandoned', 'refused', 'budget-exhausted'].includes(r.state) || WAITING_FOR_HUMANS.includes(r.state));
  const released = runs.filter((r) => r.state === 'released');
  const accepted = runs.filter((r) => r.state === 'released' || r.state === 'awaiting-release-approval' || r.state === 'accepted');
  const built = runs.filter((r) => (r.attempts ?? []).length);
  const firstPass = accepted.filter((r) => r.attempts?.length === 1);
  const escaped = incidents.length;
  const totalUsd = runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const acceptedUsd = accepted.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const failedUsd = totalUsd - acceptedUsd;
  const byRole = {};
  for (const r of runs) for (const [role, c] of Object.entries(r.costByRole ?? {})) byRole[role] = round((byRole[role] ?? 0) + c);
  const leadTimes = released.map((r) => (Date.parse(r.release?.at ?? r.updatedAt) - Date.parse(r.createdAt)) / 60000);
  // Minutes a change waited for people between «ready for approval» and release.
  const humanMinutes = released.filter((r) => r.awaitingSince && r.release?.at)
    .map((r) => (Date.parse(r.release.at) - Date.parse(r.awaitingSince)) / 60000);
  const gaps = runs.flatMap((r) => (r.overfit ?? []).filter((o) => o.visibleRate !== null).map((o) => (o.visibleRate - o.holdoutRate) * 100));
  const gateStats = new Map();
  for (const r of runs) {
    for (const a of r.attempts ?? []) {
      let firstFailSeen = false;
      for (const g of a.gates ?? []) {
        const s = gateStats.get(g.id) ?? { id: g.id, evaluated: 0, failedFirst: 0, notEarned: 0, totalMs: 0 };
        s.evaluated += 1;
        s.totalMs += g.durationMs ?? 0;
        if (g.verdict === 'NOT-EARNED') s.notEarned += 1;
        if (g.verdict !== 'PASS' && !firstFailSeen) { s.failedFirst += 1; firstFailSeen = true; }
        gateStats.set(g.id, s);
      }
    }
  }
  const queue = reviewQueue(store);
  const auto = autonomyState(store);
  return {
    generatedAt: new Date().toISOString(),
    window: { from: runs[0]?.createdAt ?? null, to: runs.at(-1)?.updatedAt ?? null },
    outcomes: {
      runs: runs.length, finished: finished.length, accepted: accepted.length, released: released.length,
      acceptedRate: round(ratio(accepted.length, built.length)), firstPassRate: round(ratio(firstPass.length, accepted.length)),
      changeFailureRate: round(ratio(escaped, released.length)), escapedDefects: escaped,
      medianLeadTimeMinutes: round(median(leadTimes), 1), humanMinutesPerChange: round(median(humanMinutes), 1),
      overfitGapPts: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 1) : null,
    },
    cost: {
      totalUsd: round(totalUsd), failedUsd: round(failedUsd), perAcceptedChangeUsd: round(ratio(totalUsd, accepted.length)),
      failedShare: round(ratio(failedUsd, totalUsd)), byRole, unknownCostRuns: runs.filter((r) => r.unknownCost).length,
    },
    review: { wip: queue.wip, wipLimit: config?.factory.review.wipLimit ?? null, oldestWaitingMinutes: queue.oldestWaitingMinutes },
    autonomy: (config?.factory.autonomy.classes ?? []).map((c) => ({ class: c.name, tier: c.tier,
      earnedTier: auto[c.name]?.demoted ? 'demoted' : (c.earnable && (auto[c.name]?.cleanStreak ?? 0) >= (config.factory.autonomy.promoteAfter ?? 5) ? 'promoted' : c.tier),
      cleanStreak: auto[c.name]?.cleanStreak ?? 0 })),
    gates: [...gateStats.values()].map((s) => ({ id: s.id, evaluated: s.evaluated, failedFirst: s.failedFirst, notEarned: s.notEarned, avgMs: Math.round(s.totalMs / s.evaluated) })),
    runs: runs.slice(-50).reverse().map((r) => ({ id: r.id, task: r.taskId, state: r.state, attempts: r.attempts?.length ?? 0, costUsd: r.costUsd ?? null,
      changeClass: r.changeClass ?? null, startedAt: r.createdAt })),
  };
}
