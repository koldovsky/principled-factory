// Run store: durable run state outside any context window (principle 2.3), hash-linked events (6.2),
// one owner per run, explicit recovery, kill switch (3.3).
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, appendJsonLine, ensureDir, newId, nowIso, readJson, readJsonLines, sha256, writeJsonAtomic } from './util.mjs';

export const TRANSITIONS = {
  created: ['refused', 'planning', 'building'],
  planning: ['awaiting-plan-approval', 'needs-human', 'budget-exhausted', 'stopped', 'interrupted'],
  'awaiting-plan-approval': ['building', 'abandoned'],
  building: ['gating', 'attempt-failed', 'budget-exhausted', 'stopped', 'interrupted'],
  gating: ['attempt-failed', 'reviewing', 'awaiting-release-approval', 'accepted', 'stopped', 'interrupted'],
  reviewing: ['awaiting-release-approval', 'accepted', 'attempt-failed', 'budget-exhausted', 'stopped', 'interrupted'],
  'attempt-failed': ['building', 'needs-human'],
  'needs-human': ['building', 'abandoned'],
  'awaiting-release-approval': ['released', 'abandoned'],
  accepted: ['released'],
  interrupted: ['planning', 'building', 'gating', 'reviewing'],
  stopped: ['planning', 'building', 'gating', 'reviewing', 'abandoned'],
  'budget-exhausted': ['abandoned'],
  refused: [], released: [], abandoned: [],
};
export const WAITING_FOR_HUMANS = ['awaiting-plan-approval', 'awaiting-release-approval', 'needs-human'];
export const TERMINAL = ['refused', 'released', 'abandoned'];

export function openStore(dir) {
  const abs = path.resolve(dir);
  ensureDir(path.join(abs, 'runs'));
  return {
    dir: abs,
    runsDir: path.join(abs, 'runs'),
    approvals: path.join(abs, 'approvals.jsonl'),
    incidents: path.join(abs, 'incidents.jsonl'),
    killswitch: path.join(abs, 'killswitch.json'),
    autonomy: path.join(abs, 'autonomy.json'),
    readiness: path.join(abs, 'readiness.json'),
    holdouts: path.join(abs, 'holdouts.json'),
  };
}

export const runDir = (store, id) => path.join(store.runsDir, id);
export const runFile = (store, id) => path.join(runDir(store, id), 'run.json');

export function appendEvent(store, runId, type, data = {}) {
  const file = path.join(runDir(store, runId), 'events.jsonl');
  const prior = readJsonLines(file);
  const prev = prior.length ? prior[prior.length - 1].hash : null;
  const event = { seq: prior.length + 1, at: nowIso(), type, data, prev };
  event.hash = sha256(JSON.stringify({ ...event, hash: undefined }));
  appendJsonLine(file, event);
  return event;
}

// Recompute the hash chain; any edited, removed or reordered event breaks it.
export function verifyEvents(store, runId) {
  const events = readJsonLines(path.join(runDir(store, runId), 'events.jsonl'));
  let prev = null;
  for (const e of events) {
    const expected = sha256(JSON.stringify({ ...e, hash: undefined }));
    if (e.prev !== prev || e.hash !== expected) return { ok: false, brokenAt: e.seq };
    prev = e.hash;
  }
  return { ok: true, events: events.length };
}

export function createRun(store, fields) {
  const id = newId('run');
  ensureDir(runDir(store, id));
  const run = { id, state: 'created', attempt: 0, costUsd: 0, createdAt: nowIso(), updatedAt: nowIso(), ...fields };
  writeJsonAtomic(runFile(store, id), run);
  appendEvent(store, id, 'created', { task: run.taskId, requestedBy: run.requestedBy });
  return run;
}

export function loadRun(store, id) {
  if (!fs.existsSync(runFile(store, id))) throw new FactoryError('NO_RUN', `no run ${id} in ${store.dir}`);
  return readJson(runFile(store, id));
}

export function saveRun(store, run) {
  run.updatedAt = nowIso();
  writeJsonAtomic(runFile(store, run.id), run);
  return run;
}

export function transition(store, run, state, data = {}) {
  const allowed = TRANSITIONS[run.state] ?? [];
  if (!allowed.includes(state)) throw new FactoryError('TRANSITION', `run ${run.id}: ${run.state} → ${state} is not allowed`);
  const from = run.state;
  run.state = state;
  run.stateSince = nowIso();
  if (data.reason) run.reason = data.reason;
  if (data.problems?.length) run.problems = data.problems;
  saveRun(store, run);
  appendEvent(store, run.id, 'transition', { from, to: state, ...data });
  return run;
}

export function listRuns(store) {
  if (!fs.existsSync(store.runsDir)) return [];
  return fs.readdirSync(store.runsDir)
    .filter((id) => fs.existsSync(runFile(store, id)))
    .map((id) => readJson(runFile(store, id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// One controller per run. A lock left by a dead process is only taken over with explicit recovery.
export function acquireLock(store, runId, { recover = false } = {}) {
  const lock = path.join(runDir(store, runId), 'lock');
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(lock, {});
    if (owner.pid && pidAlive(owner.pid) && owner.pid !== process.pid) {
      throw new FactoryError('LOCKED', `run ${runId} is owned by live process ${owner.pid}`);
    }
    if (!recover) throw new FactoryError('LOCKED', `run ${runId} has a stale lock from process ${owner.pid}; resume with --recover after checking it is not running`);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: nowIso(), recoveredFrom: owner.pid }));
    appendEvent(store, runId, 'lock-recovered', { from: owner.pid });
  }
  return () => fs.rmSync(lock, { force: true });
}

// Kill switch (principle 3.3): engaged → every tool call is denied and running agents are stopped.
export function readKillswitch(store) {
  return readJson(store.killswitch, { engaged: false, disabledTools: [] });
}

export function setKillswitch(store, patch, by) {
  const current = readKillswitch(store);
  const next = { ...current, ...patch, by, at: nowIso() };
  writeJsonAtomic(store.killswitch, next);
  return next;
}
