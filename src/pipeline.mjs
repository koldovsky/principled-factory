// The fixed stage graph (principle 3.1). Agents act only inside plan, build and review; their messages never set a status.
import fs from 'node:fs';
import path from 'node:path';
import { allowedCommands, loadConfig, checkModelApproved, FACTORY_ROOT } from './config.mjs';
import { admissionProblems, loadTask, sizeOf } from './task.mjs';
import { listSets } from './holdouts.mjs';
import { isApproved, reviewQueue } from './approvals.mjs';
import { acquireLock, appendEvent, createRun, listRuns, loadRun, openStore, readKillswitch, runDir, saveRun, transition } from './store.mjs';
import { createWorkspace, describeChange, protectedManifest, readChangedContents, removeWorkspace, FACTORY_DIR } from './workspace.mjs';
import { appendProgress, brief, writeContextPack } from './context.mjs';
import { runAgent } from './agents/index.mjs';
import { diffGate, integrityGate, judgeBaseline, judgeVisible, repeatGate, runTestCommand } from './gates/deterministic.mjs';
import { holdoutGate } from './gates/holdout.mjs';
import { judgeReview, writeReviewInputs } from './gates/review.mjs';
import { checkMaintainability } from './gates/maintainability.mjs';
import { runMutation } from './gates/mutation.mjs';
import { FAIL, NOT_EARNED, PASS } from './gates/result.mjs';
import { boundaryEvidence } from './gates/boundary.mjs';
import { decideTier } from './autonomy.mjs';
import { buildProofPack, release } from './delivery.mjs';
import { readTrace, span, traceFile } from './trace.mjs';
import { FactoryError, matchesAny, nowIso, readJson, sha256, writeJsonAtomic } from './util.mjs';

const DAY_MS = 86_400_000;

// Test-only switch that turns off one named mechanism so a test can prove the mechanism is what blocks an attack.
// Recorded on the run, shown in the proof pack, and unsafe runs can never be released.
export const UNSAFE_SWITCHES = ['admission', 'config-approval', 'wip', 'budget', 'killswitch', 'integrity', 'mutation', 'holdouts', 'autonomy', 'hook', 'trifecta', 'fail-closed',
  'confinement'];
const skip = (run, name) => (run.unsafe ?? []).includes(name);
const configOptions = (run) => ({ skipTrifecta: skip(run, 'trifecta'), unconfined: skip(run, 'confinement') });

// --- shared helpers ------------------------------------------------------------------------------------------------
function factoryVersion() {
  try { return readJson(path.join(FACTORY_ROOT, 'package.json')).version; } catch { return 'unknown'; }
}

function policyFor(role, { run, config, store, task }) {
  const r = config.factory.roles[role];
  return {
    runId: run.id, role, attempt: run.attempt, workspace: run.ws,
    protected: [...task.protected, `${FACTORY_DIR}/**`],
    readDeny: config.policy.dataBoundary.denyGlobs,
    bashAllow: role === 'builder' ? [...allowedCommands(config.profile), ...Object.values(config.profile.observe ?? {})] : [],
    networkAllowed: r.capabilities.externalComms,
    killswitch: store.killswitch,
    trace: traceFile(store, run.id),
    captureContent: config.factory.trace?.captureContent ?? false,
  };
}

// Overfit gap (principle 4.2): visible pass rate against hidden pass rate, recorded whenever holdouts ran — pass or fail.
function recordOverfit(run, attempt, hold) {
  const visible = attempt.gates.find((g) => g.id === 'visible-tests');
  if (!visible || !hold.evidence?.total) return;
  const tests = visible.evidence.tests ?? [];
  run.overfit = run.overfit ?? [];
  run.overfit.push({ attempt: run.attempt, visibleRate: tests.length ? tests.filter((t) => t.ok).length / tests.length : null,
    holdoutRate: hold.evidence.passed / hold.evidence.total });
}

function addCost(run, role, cost) {
  if (cost === null || cost === undefined) { run.unknownCost = true; return; }
  run.costUsd = Number((run.costUsd + cost).toFixed(6));
  run.costByRole = run.costByRole ?? {};
  run.costByRole[role] = Number(((run.costByRole[role] ?? 0) + cost).toFixed(6));
}

async function callAgent(role, ctx, extra = {}) {
  const { run, config, store, task } = ctx;
  const remaining = skip(run, 'budget') ? 1e9 : config.factory.budgets.runUsd - run.costUsd;
  if (remaining <= 0) return { budgetExhausted: true };
  const roleConfig = config.factory.roles[role];
  const model = roleConfig.model ?? (role === 'reviewer' ? config.factory.agent.reviewModel : null) ?? config.factory.agent.model;
  checkModelApproved(config, config.factory.agent.adapter === 'scripted' ? 'scripted' : model);
  const prompt = brief(role, { task, attempt: run.attempt, feedback: run.lastFeedback });
  const result = await span(store, run.id, `invoke_agent ${role}`, 'invoke_agent', { 'gen_ai.agent.name': role, 'gen_ai.request.model': model },
    async ({ set }) => {
      const out = await runAgent({
        role, roleConfig, config, model, prompt, ws: run.ws, runDir: runDir(store, run.id), attempt: run.attempt,
        budgetUsd: remaining, timeoutMs: config.factory.budgets.agentTimeoutMs, policy: policyFor(role, ctx),
        killswitch: () => (skip(run, 'killswitch') ? { engaged: false, disabledTools: [] } : readKillswitch(store)),
        shouldStop: () => !skip(run, 'killswitch') && readKillswitch(store).engaged, unsafeNoHook: skip(run, 'hook'),
        scripted: run.scripted, store, run, task, ...extra,
      });
      set({ 'gen_ai.response.model': out.model, 'gen_ai.usage.input_tokens': out.usage?.input_tokens ?? null,
        'gen_ai.usage.output_tokens': out.usage?.output_tokens ?? null, 'factory.cost_usd': out.costUsd, 'factory.denials': out.denials.length,
        ...(config.factory.trace?.captureContent ? { 'gen_ai.input.messages': prompt } : {}) });
      return out;
    });
  addCost(run, role, result.costUsd);
  run.lastModel = result.model ?? model;
  run.models = { ...(run.models ?? {}), [role]: result.model ?? model };
  saveRun(store, run);
  appendEvent(store, run.id, 'agent', { role, status: result.status, costUsd: result.costUsd, denials: result.denials.length, attempt: run.attempt });
  return result;
}

// --- stages --------------------------------------------------------------------------------------------------------
async function preflight(ctx) {
  const { run, store } = ctx;
  const refuse = (reason, problems = []) => { transition(store, run, 'refused', { reason, problems }); return 'stop'; };
  let config;
  try { config = loadConfig(run.controlDir, configOptions(run)); } catch (error) { return refuse(error.message); }
  ctx.config = config;
  run.configDigest = config.digest;
  if (!skip(run, 'config-approval') && !isApproved(store, 'config', 'factory', config.digest)) {
    return refuse(`factory configuration ${config.digest.slice(0, 12)}… is not approved by a human (factory approve config --as <name>)`);
  }
  try { checkModelApproved(config, config.factory.agent.adapter === 'scripted' ? 'scripted' : config.factory.agent.model); } catch (error) { return refuse(error.message); }
  if (!skip(run, 'killswitch') && readKillswitch(store).engaged) return refuse('the kill switch is engaged');
  const since = Date.now() - DAY_MS;
  const spentToday = listRuns(store).filter((r) => Date.parse(r.createdAt) >= since && r.id !== run.id).reduce((n, r) => n + (r.costUsd ?? 0), 0);
  if (!skip(run, 'budget') && spentToday >= config.factory.budgets.dailyUsd) return refuse(`daily spend $${spentToday.toFixed(2)} reached the $${config.factory.budgets.dailyUsd} limit`);
  const queue = reviewQueue(store);
  if (!skip(run, 'wip') && queue.wip >= config.factory.review.wipLimit) {
    return refuse(`${queue.wip} item(s) already wait for people (limit ${config.factory.review.wipLimit}); review them before starting more work`);
  }
  const readiness = readJson(store.readiness, null);
  const maxAge = (config.factory.readiness?.maxAgeDays ?? 7) * DAY_MS;
  if (!readiness?.ok || path.resolve(readiness.target) !== path.resolve(run.targetDir) || Date.now() - Date.parse(readiness.at) > maxAge) {
    return refuse('the target has no recent passing readiness check (factory doctor)');
  }
  const { task, digest } = loadTask(run.controlDir, run.taskId);
  ctx.task = task;
  run.taskDigest = digest;
  run.taskTitle = task.title;
  const problems = admissionProblems({ task, digest, controlDir: run.controlDir, targetDir: run.targetDir, store, holdoutIds: listSets(run.controlDir) });
  if (problems.length && !skip(run, 'admission')) return refuse('task not admissible', problems);
  run.ws = path.join(runDir(store, run.id), 'ws');
  if (fs.existsSync(run.ws)) removeWorkspace(run.targetDir, run.ws);
  const { base, ws } = createWorkspace(run.targetDir, run.ws);
  run.base = base;
  run.ws = ws;
  const baseline = await runTestCommand({ ws: run.ws, profile: config.profile });
  const baseProblems = judgeBaseline(baseline, task);
  if (baseProblems.length && !skip(run, 'admission')) { removeWorkspace(run.targetDir, run.ws); return refuse('acceptance tests do not prove the change', baseProblems); }
  // Task-protected files are fingerprinted once, from the base commit; factory files per attempt.
  run.manifest = protectedManifest(run.ws, task.protected);
  run.size = sizeOf(task);
  run.maxAttempts = config.factory.budgets.maxAttempts;
  run.versions = { factory: factoryVersion(), node: process.version, platform: process.platform, adapter: config.factory.agent.adapter };
  saveRun(store, run);
  transition(store, run, run.size === 'small' ? 'building' : 'planning', { size: run.size });
  return 'continue';
}

async function planning(ctx) {
  const { run, store, config, task } = ctx;
  if (!config.factory.roles.planner) throw new FactoryError('CONFIG', `task ${task.id} is ${run.size} and needs a plan, but no planner role is configured`);
  writeContextPack({ ws: run.ws, config, task, profile: config.profile });
  run.factoryManifest = protectedManifest(run.ws, [`${FACTORY_DIR}/**`]);
  const out = await callAgent('planner', ctx);
  if (out.budgetExhausted) { transition(store, run, 'budget-exhausted', { reason: 'run budget spent' }); return 'stop'; }
  if (out.status === 'stopped') { run.lastStage = 'planning'; transition(store, run, 'stopped', { reason: 'kill switch' }); return 'stop'; }
  if (out.status !== 'completed' || !out.resultText.trim()) {
    transition(store, run, 'needs-human', { reason: 'the planner did not produce a plan', question: 'Write or adjust the plan, then answer to continue.' });
    return 'stop';
  }
  fs.writeFileSync(path.join(runDir(store, run.id), 'plan.md'), out.resultText);
  run.planDigest = sha256(out.resultText);
  transition(store, run, 'awaiting-plan-approval', { planDigest: run.planDigest });
  return 'stop';
}

async function building(ctx) {
  const { run, store, config, task } = ctx;
  if (!skip(run, 'killswitch') && readKillswitch(store).engaged) { run.lastStage = 'building'; transition(store, run, 'stopped', { reason: 'kill switch' }); return 'stop'; }
  run.attempt += 1;
  const planFile = path.join(runDir(store, run.id), 'plan.md');
  const plan = run.planDigest && fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : null;
  writeContextPack({ ws: run.ws, config, task, plan, profile: config.profile });
  run.factoryManifest = protectedManifest(run.ws, [`${FACTORY_DIR}/**`]);
  saveRun(store, run);
  const out = await callAgent('builder', ctx);
  if (out.budgetExhausted) { transition(store, run, 'budget-exhausted', { reason: 'run budget spent before the build' }); return 'stop'; }
  if (out.status === 'stopped') { run.attempt -= 1; run.lastStage = 'building'; saveRun(store, run); transition(store, run, 'stopped', { reason: 'kill switch' }); return 'stop'; }
  run.attempts.push({ n: run.attempt, agent: { status: out.status, costUsd: out.costUsd, denials: out.denials, durationMs: out.durationMs }, gates: [] });
  if (!skip(run, 'budget') && run.costUsd > config.factory.budgets.runUsd) {
    transition(store, run, 'budget-exhausted', { reason: `run spend $${run.costUsd.toFixed(4)} exceeded the $${config.factory.budgets.runUsd} budget` });
    return 'stop';
  }
  if (out.status !== 'completed') {
    return failAttempt(ctx, `the builder agent ended with status ${out.status}`, { summary: `Your previous session ended with status ${out.status}.` });
  }
  transition(store, run, 'gating', { attempt: run.attempt });
  return 'continue';
}

async function gating(ctx) {
  const { run, store, config, task } = ctx;
  const attempt = run.attempts[run.attempts.length - 1];
  const change = describeChange(run.ws, run.base);
  ctx.change = change;
  const order = config.factory.gates.order.filter((g) => g !== 'review' && !skip(run, g));
  let testRun = null;
  attempt.notApplicable = [];
  // The boundary must leave evidence before any gate is trusted; the command adapter has no hook (stated in the proof pack).
  if (config.factory.agent.adapter !== 'command' && !skip(run, 'hook')) {
    attempt.boundary = boundaryEvidence({ spans: readTrace(store, run.id), attempt: run.attempt, changedFiles: change.files.length });
    saveRun(store, run);
    if (attempt.boundary.verdict !== PASS) return failAttempt(ctx, `boundary: ${attempt.boundary.verdict}`, attempt.boundary.feedback, attempt.boundary);
  }
  const changedSource = change.files.map((f) => f.file)
    .filter((f) => matchesAny(f, config.profile.sourceGlobs) && !matchesAny(f, [...task.protected, ...config.profile.testGlobs]));
  for (const id of order) {
    // Gates whose scope is empty are recorded as not applicable (shown in the proof pack), never as a pass.
    if (['maintainability', 'mutation'].includes(id) && !changedSource.length) {
      attempt.notApplicable.push(`${id}: no source files changed`);
      continue;
    }
    const result = await span(store, run.id, `gate ${id}`, 'gate', { 'factory.gate': id }, async ({ set }) => {
      const r = await runGate(id, { ...ctx, change, testRun: () => testRun, setTestRun: (t) => { testRun = t; } });
      set({ 'factory.verdict': r.verdict });
      return r;
    });
    // Zero mutants means the changed lines hold no mutable operator: not applicable, recorded — any other NOT-EARNED blocks.
    if (id === 'mutation' && result.verdict === NOT_EARNED && (result.evidence?.total ?? 0) === 0) {
      attempt.notApplicable.push('mutation: no mutable operators on the changed lines');
      continue;
    }
    attempt.gates.push(result);
    if (id === 'holdouts') recordOverfit(run, attempt, result);
    saveRun(store, run);
    // UNSAFE test switch 'fail-closed': counts missing evidence (NOT-EARNED) as a pass, to show what fail-closed prevents.
    const failOpen = skip(run, 'fail-closed') && result.verdict === NOT_EARNED;
    if (result.verdict !== PASS && !failOpen) {
      return failAttempt(ctx, `gate ${id}: ${result.verdict}`, result.feedback, result);
    }
  }
  saveRun(store, run);
  if (config.factory.gates.order.includes('review') && config.factory.roles.reviewer) {
    transition(store, run, 'reviewing', {});
    return 'continue';
  }
  return route(ctx, change);
}

async function runGate(id, ctx) {
  const { run, config, task, store, change } = ctx;
  const sourceFiles = change.files.map((f) => f.file).filter((f) => matchesAny(f, config.profile.sourceGlobs) && !matchesAny(f, [...task.protected, ...config.profile.testGlobs]));
  switch (id) {
    case 'integrity': return integrityGate({ ws: run.ws, manifest: { ...run.manifest, ...run.factoryManifest }, globs: [...task.protected, `${FACTORY_DIR}/**`] });
    case 'diff': return diffGate({ change, limit: config.factory.gates.diffBudgetLines ?? 300 });
    case 'maintainability': return checkMaintainability({ root: run.ws, files: change.files.map((f) => f.file), rules: config.rules });
    case 'visible-tests': {
      const t = await runTestCommand({ ws: run.ws, profile: config.profile, shouldStop: () => readKillswitch(store).engaged });
      ctx.setTestRun(t);
      return judgeVisible(t, task);
    }
    case 'repeat': return repeatGate({ ws: run.ws, profile: config.profile, task, times: config.factory.gates.repeat ?? 1, first: ctx.testRun() });
    case 'mutation': {
      const m = config.factory.gates.mutation ?? {};
      return runMutation({ root: run.ws, files: sourceFiles, changedLines: change.changedLines, maxMutants: m.maxMutants ?? 8, minScore: m.minScore ?? 0.6,
        runTests: async () => ({ passed: judgeVisible(await runTestCommand({ ws: run.ws, profile: config.profile }), task).verdict === PASS }) });
    }
    case 'holdouts': return holdoutGate({ config, task, ws: run.ws, store, changedContents: readChangedContents(run.ws, change.files) });
    default: throw new FactoryError('CONFIG', `unknown gate ${id}`);
  }
}

async function reviewing(ctx) {
  const { run, store, task } = ctx;
  const change = ctx.change ?? describeChange(run.ws, run.base);
  writeReviewInputs(run.ws, change.patch);
  const out = await callAgent('reviewer', ctx);
  if (out.budgetExhausted) { transition(store, run, 'budget-exhausted', { reason: 'run budget spent before review' }); return 'stop'; }
  if (out.status === 'stopped') { run.lastStage = 'reviewing'; transition(store, run, 'stopped', { reason: 'kill switch' }); return 'stop'; }
  const result = judgeReview(out, run.ws);
  run.attempts[run.attempts.length - 1].gates.push(result);
  saveRun(store, run);
  if (result.verdict === FAIL) return failAttempt(ctx, 'review found blocking problems', result.feedback, result);
  if (result.verdict === NOT_EARNED) {
    transition(store, run, 'attempt-failed', { reason: result.summary });
    transition(store, run, 'needs-human', { reason: result.summary, question: 'The reviewer produced no usable verdict. Re-run review, review manually, or abandon?' });
    return 'stop';
  }
  void task;
  return route(ctx, change);
}

function notVerifiedList(ctx) {
  const { config, task } = ctx;
  const order = config.factory.gates.order;
  const items = (ctx.run.unsafe ?? []).map((u) => `UNSAFE TEST RUN: mechanism "${u}" was switched off; this run can never be released`);
  for (const g of ['maintainability', 'repeat', 'mutation', 'holdouts', 'review']) if (!order.includes(g)) items.push(`gate "${g}" is not enabled for this factory`);
  if (!task.holdouts.length) items.push('no hidden scenarios: only visible tests define acceptance');
  const adapter = config.factory.agent.adapter;
  if (adapter === 'scripted') items.push('agent adapter "scripted": boundaries enforced by the factory\'s policy function, not by Claude Code\'s hook');
  if (adapter === 'command') items.push('agent adapter "command": NO tool-level confinement; only the external CLI\'s own settings limited it, and its cost is unknown');
  items.push(config.profile.confined
    ? 'code the agent wrote ran under Node\'s permission model, its files limited to the workspace; not confined: its network access, '
      + 'its own test report (same process) and the holdout evaluator, which runs the candidate unconfined (docs/trust.md)'
    : 'isolation is policy-level in one OS account: code the agent wrote and ran (tests) could read other files (docs/trust.md)');
  for (const na of ctx.run.attempts.at(-1)?.notApplicable ?? []) items.push(`not applicable — ${na}`);
  const mutation = ctx.run.attempts.at(-1)?.gates.find((g) => g.id === 'mutation');
  for (const s of mutation?.evidence?.survived ?? []) items.push(`mutant survived at ${s.file}:${s.line} (${s.operator}): no test pins this line`);
  return items;
}

function route(ctx, change) {
  const { run, store, config, task } = ctx;
  const decided = decideTier(store, change.files, config.factory.autonomy, config.policy);
  const tier = skip(run, 'autonomy') ? { tier: 'auto', reason: 'UNSAFE: autonomy check skipped' } : decided;
  const cls = { name: decided.classNames.join(', ') };
  run.changeClass = decided.className;
  run.changeClasses = decided.classNames;
  run.tier = tier.tier;
  const planFile = path.join(runDir(store, run.id), 'plan.md');
  const { markdown, digest } = buildProofPack({ run, task, attempt: run.attempts.at(-1), change, tier, cls,
    plan: run.planDigest && fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : null, notVerified: notVerifiedList(ctx) });
  fs.writeFileSync(path.join(runDir(store, run.id), 'proof-pack.md'), markdown);
  run.proofDigest = digest;
  saveRun(store, run);
  if (tier.tier === 'auto') {
    transition(store, run, 'accepted', { tier: tier.tier, changeClass: decided.className, proofDigest: digest });
    if (!run.unsafe?.length) release({ store, runId: run.id, config, by: run.requestedBy, approvers: [] });
    return 'stop';
  }
  run.awaitingSince = nowIso();
  transition(store, run, 'awaiting-release-approval', { tier: tier.tier, changeClass: decided.className, proofDigest: digest, reason: tier.reason });
  return 'stop';
}

function failAttempt(ctx, reason, feedback, gate = null) {
  const { run, store, config } = ctx;
  const text = [`## Attempt ${run.attempt}: not accepted`, feedback?.summary ?? reason, feedback?.remediation ? `\nHow to fix:\n${feedback.remediation}` : ''].join('\n');
  run.lastFeedback = text;
  saveRun(store, run);
  if (fs.existsSync(path.join(run.ws, FACTORY_DIR))) appendProgress(run.ws, text);
  transition(store, run, 'attempt-failed', { reason, gate: gate?.id ?? null, verdict: gate?.verdict ?? null });
  if (run.attempt < run.maxAttempts) {
    transition(store, run, 'building', { retry: run.attempt + 1 });
    return 'continue';
  }
  const deadline = new Date(Date.now() + config.factory.escalation.defaultAfterHours * 3_600_000).toISOString();
  run.escalation = { owner: config.factory.escalation.owner, question: `Attempts exhausted (${run.maxAttempts}). Last failure: ${reason}. What should change — the task, the acceptance cases, or the approach?`,
    defaultAction: config.factory.escalation.defaultAction, deadline };
  saveRun(store, run);
  transition(store, run, 'needs-human', { reason, ...run.escalation });
  return 'stop';
}

const STAGES = { created: preflight, planning, building, gating, reviewing };

// Advance a run until it waits for people, finishes or is stopped. State lives in the store, so any process can resume.
export async function advance({ store, runId, recover = false }) {
  const unlock = acquireLock(store, runId, { recover });
  const run = loadRun(store, runId);
  const ctx = { run, store };
  try {
    return await span(store, run.id, 'invoke_workflow factory.run', 'invoke_workflow', { 'factory.task': run.taskId }, async () => {
      if (run.state !== 'created') {
        ctx.config = loadConfig(run.controlDir, configOptions(run));
        if (ctx.config.digest !== run.configDigest) {
          throw new FactoryError('CONFIG_CHANGED', `factory configuration changed during run ${run.id} (${run.configDigest.slice(0, 12)} → ${ctx.config.digest.slice(0, 12)}); start a new run`);
        }
        ctx.task = loadTask(run.controlDir, run.taskId).task;
      }
      for (let guard = 0; guard < 100; guard++) {
        const stage = STAGES[run.state];
        if (!stage) return run;
        try {
          if ((await stage(ctx)) === 'stop') return run;
        } catch (error) {
          if (['building', 'gating', 'reviewing', 'planning'].includes(run.state)) {
            run.lastStage = run.state;
            transition(store, run, 'interrupted', { reason: error.message });
          }
          throw error;
        }
      }
      return run;
    });
  } finally {
    unlock();
  }
}

export async function startRun({ controlDir, targetDir, storeDir, taskId, requestedBy, scripted = null, unsafe = [] }) {
  if (!requestedBy) throw new FactoryError('IDENTITY', 'a run needs a named requester (--as <name>)');
  const bad = unsafe.filter((u) => !UNSAFE_SWITCHES.includes(u));
  if (bad.length) throw new FactoryError('USAGE', `unknown unsafe switch(es): ${bad.join(', ')}`);
  const store = openStore(storeDir);
  const run = createRun(store, { taskId, requestedBy, controlDir: path.resolve(controlDir), targetDir: path.resolve(targetDir), scripted, unsafe, attempts: [], costUsd: 0, costByRole: {} });
  return advance({ store, runId: run.id });
}

export async function resumeRun({ storeDir, runId, recover = false }) {
  const store = openStore(storeDir);
  const run = loadRun(store, runId);
  if (['interrupted', 'stopped'].includes(run.state)) {
    if (readKillswitch(store).engaged) throw new FactoryError('KILLSWITCH', 'the kill switch is engaged; release it first');
    transition(store, run, run.lastStage ?? 'building', { resumed: true });
  }
  return advance({ store, runId, recover });
}

export function writeReadiness(store, record) {
  writeJsonAtomic(store.readiness, { ...record, at: nowIso() });
}
