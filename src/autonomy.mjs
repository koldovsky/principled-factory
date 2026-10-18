// Risk-tiered, earned autonomy (principle 7.1) under the AI policy's unattended classes (8.3).
import { matchesAny, readJson, writeJsonAtomic } from './util.mjs';

const RANK = { auto: 0, 'one-human': 1, 'two-humans': 2 };
const BY_RANK = ['auto', 'one-human', 'two-humans'];

// The most restrictive class touched by the change decides.
export function classify(files, autonomy) {
  let chosen = { name: 'default', tier: autonomy.default, earnable: false };
  for (const { file } of files) {
    const match = autonomy.classes.find((c) => matchesAny(file, c.paths)) ?? { name: 'default', tier: autonomy.default, earnable: false };
    if (RANK[match.tier] > RANK[chosen.tier] || chosen.name === 'default') chosen = match;
  }
  return chosen;
}

export function autonomyState(store) {
  return readJson(store.autonomy, {});
}

export function effectiveTier(store, cls, autonomy, policy) {
  const state = autonomyState(store)[cls.name] ?? { cleanStreak: 0, demoted: false };
  let rank = RANK[cls.tier];
  let reason = `class ${cls.name} is ${cls.tier}`;
  const promoteAfter = autonomy.promoteAfter ?? 5;
  if (state.demoted) {
    rank = Math.min(2, rank + 1);
    reason = `class ${cls.name} demoted after an incident until ${promoteAfter} clean releases (now ${state.cleanStreak})`;
  } else if (cls.earnable && rank > 0 && state.cleanStreak >= promoteAfter) {
    rank -= 1;
    reason = `class ${cls.name} earned one tier after ${state.cleanStreak} clean releases`;
  }
  if (rank === 0 && !policy.unattendedClasses.includes(cls.name)) {
    rank = 1;
    reason += '; the AI policy does not allow this class unattended';
  }
  return { tier: BY_RANK[rank], reason, state };
}

export function recordRelease(store, className, promoteAfter = 5) {
  const all = autonomyState(store);
  const s = all[className] ?? { cleanStreak: 0, demoted: false };
  s.cleanStreak += 1;
  if (s.demoted && s.cleanStreak >= promoteAfter) s.demoted = false;
  all[className] = s;
  writeJsonAtomic(store.autonomy, all);
  return s;
}

export function recordIncident(store, className) {
  const all = autonomyState(store);
  all[className] = { cleanStreak: 0, demoted: true };
  writeJsonAtomic(store.autonomy, all);
  return all[className];
}
