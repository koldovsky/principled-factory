// Command-line interface. Paths come from flags or FACTORY_CONTROL / FACTORY_TARGET / FACTORY_STORE.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { loadTask } from './task.mjs';
import { recordApproval, releaseApprovalStatus, assertReleaseApprover, reviewQueue } from './approvals.mjs';
import { openStore, loadRun, listRuns, transition, readKillswitch, setKillswitch, verifyEvents, runDir } from './store.mjs';
import { advance, resumeRun, startRun } from './pipeline.mjs';
import { doctor } from './doctor.mjs';
import { release, recordIncidentForRun } from './delivery.mjs';
import { appendProgress } from './context.mjs';
import { computeMetrics } from './metrics.mjs';
import { renderDashboard } from './dashboard.mjs';
import { listSets, retireSet, sealFile, setStatus } from './holdouts.mjs';
import { assess, intake, recordResult, registerExperiment } from './improve.mjs';
import { gc } from './gc.mjs';
import { conformance, formatConformance } from './conformance.mjs';
import { FactoryError, readJson, sha256 } from './util.mjs';

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const need = (args, key, env) => {
  const v = args[key] ?? (env ? process.env[env] : undefined);
  if (!v || v === true) throw new FactoryError('USAGE', `missing --${key}${env ? ` (or ${env})` : ''}`);
  return v;
};
const dirs = (args) => ({ control: args.control ?? process.env.FACTORY_CONTROL, target: args.target ?? process.env.FACTORY_TARGET, store: need(args, 'store', 'FACTORY_STORE') });

function printRun(run) {
  const last = run.attempts?.at(-1);
  console.log(`${run.id}  ${run.taskId}  state=${run.state}${run.reason ? `  (${run.reason})` : ''}`);
  if (run.problems?.length) for (const p of run.problems) console.log(`  - ${p}`);
  console.log(`  attempts ${run.attempts?.length ?? 0}/${run.maxAttempts ?? '?'} · cost $${(run.costUsd ?? 0).toFixed(4)}${run.unknownCost ? ' (+unknown)' : ''}${run.tier ? ` · class ${run.changeClass} → ${run.tier}` : ''}`);
  for (const g of [last?.boundary, ...(last?.gates ?? [])].filter(Boolean)) console.log(`  ${g.verdict.padEnd(10)} ${g.id.padEnd(16)} ${g.summary}`);
  for (const na of last?.notApplicable ?? []) console.log(`  ${'n/a'.padEnd(10)} ${na}`);
  if (run.proofDigest && run.state === 'awaiting-release-approval') console.log(`  proof pack ${run.proofDigest} — factory proof ${run.id}`);
  if (run.escalation && run.state === 'needs-human') console.log(`  question for ${run.escalation.owner}: ${run.escalation.question} (default ${run.escalation.defaultAction} at ${run.escalation.deadline})`);
  if (run.release) console.log(`  released to branch ${run.release.branch} at ${run.release.commit.slice(0, 12)} · rollback target ${run.release.rollbackTarget.slice(0, 12)} · not pushed`);
}

const COMMANDS = {
  async doctor(args) {
    const { control, target, store } = dirs(args);
    const r = await doctor({ controlDir: control, targetDir: target, storeDir: store });
    for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(20)} ${c.detail}`);
    console.log(r.ok ? 'ready' : 'not ready: fix the failing checks before running agents');
    return r.ok ? 0 : 1;
  },
  async approve(args) {
    const [kind, subject] = args._;
    const by = need(args, 'as');
    const { control, store: storeDir } = dirs(args);
    const store = openStore(storeDir);
    if (kind === 'config') {
      const config = loadConfig(control);
      recordApproval(store, { kind: 'config', subject: 'factory', digest: config.digest, by, note: args.note ?? '' }, config.policy);
      console.log(`approved factory configuration ${config.digest}`);
      return 0;
    }
    if (kind === 'intent') {
      const config = loadConfig(control);
      const { digest } = loadTask(control, subject);
      recordApproval(store, { kind: 'intent', subject, digest, by }, config.policy);
      console.log(`approved intent of task ${subject} at ${digest}`);
      return 0;
    }
    const run = loadRun(store, subject);
    const config = loadConfig(run.controlDir);
    if (kind === 'plan') {
      if (run.state !== 'awaiting-plan-approval') throw new FactoryError('STATE', `run ${run.id} is ${run.state}`);
      const digest = args.digest ?? run.planDigest;
      if (digest !== run.planDigest) throw new FactoryError('PROOF', 'the digest does not match the current plan');
      recordApproval(store, { kind: 'plan', subject: run.id, digest, by }, config.policy);
      transition(store, run, 'building', { planApprovedBy: by });
      printRun(await advance({ store, runId: run.id }));
      return 0;
    }
    if (kind === 'release') {
      if (run.state !== 'awaiting-release-approval') throw new FactoryError('STATE', `run ${run.id} is ${run.state}`);
      const proof = need(args, 'proof');
      assertReleaseApprover(run, by, proof);
      recordApproval(store, { kind: 'release', subject: run.id, digest: proof, by }, config.policy);
      const status = releaseApprovalStatus(store, run, run.tier);
      if (!status.satisfied) { console.log(`approval recorded (${status.have}/${status.needed}); waiting for another approver`); return 0; }
      printRun(release({ store, runId: run.id, config, by, approvers: status.approvers }));
      return 0;
    }
    throw new FactoryError('USAGE', 'approve config | intent <task> | plan <run> | release <run> --proof <digest>');
  },
  async run(args) {
    const { control, target, store } = dirs(args);
    const scripted = args.behaviour ? Object.fromEntries(String(args.behaviour).split(',').map((p) => p.includes('=') ? p.split('=') : ['builder', p])) : null;
    const run = await startRun({ controlDir: need({ control }, 'control'), targetDir: need({ target }, 'target'), storeDir: store, taskId: need({ task: args._[0] }, 'task'), requestedBy: need(args, 'as'), scripted });
    printRun(loadRun(openStore(store), run.id));
    return 0;
  },
  async resume(args) {
    const run = await resumeRun({ storeDir: dirs(args).store, runId: args._[0], recover: Boolean(args.recover) });
    printRun(loadRun(openStore(dirs(args).store), run.id));
    return 0;
  },
  async answer(args) {
    const store = openStore(dirs(args).store);
    const run = loadRun(store, args._[0]);
    if (run.state !== 'needs-human') throw new FactoryError('STATE', `run ${run.id} is ${run.state}`);
    const by = need(args, 'as');
    appendProgress(run.ws, `## Guidance from ${by}\n${need(args, 'text')}`);
    run.maxAttempts += 1;
    transition(store, run, 'building', { answeredBy: by });
    printRun(await advance({ store, runId: run.id }));
    return 0;
  },
  async sweep(args) {
    const store = openStore(dirs(args).store);
    for (const run of listRuns(store).filter((r) => r.state === 'needs-human' && r.escalation && Date.parse(r.escalation.deadline) <= Date.now())) {
      transition(store, run, 'abandoned', { reason: `no answer by ${run.escalation.deadline}; default action ${run.escalation.defaultAction}` });
      console.log(`abandoned ${run.id} (escalation default)`);
    }
    return 0;
  },
  async stop(args) {
    const store = openStore(dirs(args).store);
    const by = need(args, 'as');
    const ks = readKillswitch(store);
    const next = args.tool ? setKillswitch(store, { disabledTools: [...new Set([...(ks.disabledTools ?? []), args.tool])] }, by)
      : setKillswitch(store, { engaged: true, reason: args.reason ?? 'stopped by operator' }, by);
    console.log(JSON.stringify(next));
    return 0;
  },
  async start(args) {
    const store = openStore(dirs(args).store);
    console.log(JSON.stringify(setKillswitch(store, { engaged: false, disabledTools: [] }, need(args, 'as'))));
    return 0;
  },
  async status(args) {
    const store = openStore(dirs(args).store);
    if (args._[0]) { printRun(loadRun(store, args._[0])); return 0; }
    for (const run of listRuns(store)) printRun(run);
    const q = reviewQueue(store);
    console.log(`review queue: ${q.wip} waiting, oldest ${q.oldestWaitingMinutes} min`);
    return 0;
  },
  async proof(args) {
    const store = openStore(dirs(args).store);
    const text = fs.readFileSync(path.join(runDir(store, args._[0]), 'proof-pack.md'), 'utf8');
    console.log(text);
    console.log(`digest: ${sha256(text)}`);
    return 0;
  },
  async incident(args) {
    const store = openStore(dirs(args).store);
    const r = recordIncidentForRun({ store, runId: args._[0], by: need(args, 'as'), summary: need(args, 'summary') });
    console.log(`incident ${r.incident.id} recorded; class ${r.incident.changeClass} demoted`);
    return 0;
  },
  async report(args) {
    const { control, store } = dirs(args);
    const metrics = computeMetrics(openStore(store), { config: control ? loadConfig(control) : null });
    if (args.html) { fs.writeFileSync(args.html, renderDashboard(metrics)); console.log(`dashboard written to ${args.html}`); }
    console.log(JSON.stringify(args.html ? metrics.outcomes : metrics, null, 2));
    return 0;
  },
  async holdouts(args) {
    const [sub, id] = args._;
    const { control, store } = dirs({ ...args, store: args.store ?? process.env.FACTORY_STORE ?? '.' });
    if (sub === 'seal') { console.log(`sealed ${sealFile(need({ control }, 'control'), id, { keyEnv: args['key-env'] ?? 'FACTORY_HOLDOUT_KEY' })}`); return 0; }
    if (sub === 'list') { for (const s of listSets(control)) console.log(`${s}  ${setStatus(openStore(store), s).status}`); return 0; }
    if (sub === 'retire') { console.log(JSON.stringify(retireSet(openStore(store), id, need(args, 'reason'), need(args, 'as')))); return 0; }
    throw new FactoryError('USAGE', 'holdouts seal <set> | list | retire <set> --reason <text> --as <name>');
  },
  async improve(args) {
    const [sub, id] = args._;
    const store = openStore(dirs(args).store);
    if (sub === 'intake') { console.log(JSON.stringify(intake(store).summary, null, 2)); return 0; }
    if (sub === 'register') {
      const exp = readJson(need(args, 'file'));
      const policy = args.control ? loadConfig(args.control).policy : null;
      console.log(JSON.stringify(registerExperiment(store, exp, need(args, 'as'), policy), null, 2));
      return 0;
    }
    if (sub === 'record') { recordResult(store, id, need(args, 'run')); console.log('recorded'); return 0; }
    if (sub === 'assess') { console.log(JSON.stringify(assess(store, id), null, 2)); return 0; }
    throw new FactoryError('USAGE', 'improve intake | register --file exp.json --as <name> | record <exp> --run <run> | assess <exp>');
  },
  async gc(args) {
    const { control, target, store } = dirs(args);
    const r = gc({ controlDir: control, targetDir: target, storeDir: store });
    console.log(`${r.findings} finding(s); ${r.proposals.length} draft cleanup task(s) in ${path.join(store, 'gc', 'proposals')}`);
    return 0;
  },
  async conformance() {
    const result = await conformance();
    console.log(formatConformance(result));
    return result.ok ? 0 : 1;
  },
  async 'verify-events'(args) {
    const r = verifyEvents(openStore(dirs(args).store), args._[0]);
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  },
};

export async function main(argv) {
  const [command, ...rest] = argv;
  const fn = COMMANDS[command];
  if (!fn) {
    console.log(`usage: factory <${Object.keys(COMMANDS).join('|')}> [options]`);
    return command ? 2 : 0;
  }
  try {
    return await fn(parse(rest));
  } catch (error) {
    console.error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
    return 1;
  }
}
