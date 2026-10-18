// Risk-tiered, earned autonomy (principle 7.1) under the AI policy's unattended classes (8.3).
import { matchesAny, readJson, writeJsonAtomic } from './util.mjs';

const RANK = { auto: 0, 'one-human': 1, 'two-humans': 2 };
const BY_RANK = ['auto', 'one-human', 'two-humans'];

const defaultClass = (autonomy) => ({ name: 'default', tier: autonomy.default, earnable: false });

// Every class a change touches; a file that matches no class carries the default tier.
export function classesTouched(files, autonomy) {
  const seen = new Map();
  for (const { file } of files) {
    const c = autonomy.classes.find((k) => matchesAny(file, k.paths)) ?? defaultClass(autonomy);
    if (!seen.has(c.name)) seen.set(c.name, c);
  }
  return seen.size ? [...seen.values()] : [defaultClass(autonomy)];
}

// The most restrictive class touched by the change, by configured tier.
export function classify(files, autonomy) {
  return classesTouched(files, autonomy).reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a));
}

// The approval tier of a change: the most restrictive *effective* tier over every class it touches. A file can never ride on a
// lower-risk class listed after it, nor on another class's earned autonomy.
export function decideTier(store, files, autonomy, policy) {
  const tiers = classesTouched(files, autonomy).map((cls) => ({ cls, ...effectiveTier(store, cls, autonomy, policy) }));
  const top = tiers.reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a));
  return { tier: top.tier, reason: top.reason, className: top.cls.name, classNames: tiers.map((t) => t.cls.name) };
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
