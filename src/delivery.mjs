// Proof packs, release and incidents (principles 2.1, 6.2, 7.2, 8.1, 8.2).
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, appendJsonLine, git, newId, nowIso, sha256 } from './util.mjs';
import { recordIncident, recordRelease } from './autonomy.mjs';
import { appendEvent, loadRun, transition } from './store.mjs';
import { removeWorkspace, FACTORY_DIR } from './workspace.mjs';

const fmtUsd = (n) => (n === null || n === undefined ? 'unknown' : `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`);

// What a reviewer needs to approve in minutes: requirement → evidence, gates, what was NOT verified, risk, cost.
export function buildProofPack({ run, task, attempt, change, plan, tier, cls, notVerified }) {
  const gate = (id) => attempt.gates.find((g) => g.id === id);
  const visible = new Map((gate('visible-tests')?.evidence?.tests ?? []).map((t) => [t.name, t.ok]));
  const holdoutSets = new Map((gate('holdouts')?.evidence?.sets ?? []).map((s) => [s.id, s]));
  const reqLines = task.requirements.map((r) => {
    const refs = r.verifiedBy.map((ref) => {
      const [kind, name] = ref.split(':');
      if (kind === 'visible') return `${name} ${visible.get(name) ? '✓' : '✗'}`;
      const s = holdoutSets.get(name);
      return `holdout ${name} ${s ? `${s.passed}/${s.total}` : 'not run'}`;
    });
    return `| ${r.id} | ${r.description} | ${refs.join(', ')} |`;
  });
  const review = gate('review');
  const lines = [
    `# Proof pack · ${task.title}`,
    '',
    `Run \`${run.id}\` · task \`${task.id}\` (digest ${run.taskDigest.slice(0, 12)}) · attempt ${attempt.n} of ${run.maxAttempts}`,
    `Requested by ${run.requestedBy} · risk class **${cls.name}** → approval tier **${tier.tier}** (${tier.reason})`,
    '',
    '## Requirements and evidence',
    '| Requirement | Description | Evidence |', '|---|---|---|', ...reqLines,
    '',
    '## Gates',
    '| Gate | Verdict | Summary |', '|---|---|---|',
    ...(attempt.boundary ? [`| boundary | ${attempt.boundary.verdict} | ${attempt.boundary.summary.replaceAll('|', '\\|')} |`] : []),
    ...attempt.gates.map((g) => `| ${g.id} | ${g.verdict} | ${g.summary.replaceAll('|', '\\|')} |`),
    '',
    '## Not verified',
    ...(notVerified.length ? notVerified.map((n) => `- ${n}`) : ['- nothing beyond the limits stated in docs/trust.md']),
    '',
    '## Change',
    ...change.files.map((f) => `- \`${f.file}\` +${f.added} −${f.removed}`),
    '',
    '## Review notes',
    ...(review?.evidence?.findings?.length ? review.evidence.findings.map((f) => `- ${f.severity}: ${f.file}:${f.line} — ${f.claim}`) : ['- none']),
    '',
    '## Cost and provenance',
    `- Total ${fmtUsd(run.costUsd)} (${Object.entries(run.costByRole ?? {}).map(([r, c]) => `${r} ${fmtUsd(c)}`).join(', ')}) across ${run.attempts.length} attempt(s)`,
    `- Models ${Object.entries(run.models ?? {}).map(([role, m]) => `${role} ${m}`).join(', ') || 'unknown'} · factory config ${run.configDigest.slice(0, 12)} · base commit ${run.base?.slice(0, 12)} · node ${process.version} · ${process.platform}`,
    plan ? '\n## Approved plan\n\n' + plan.trim() : '',
  ];
  const markdown = lines.join('\n') + '\n';
  return { markdown, digest: sha256(markdown) };
}

export function release({ store, runId, config, by, approvers }) {
  const run = loadRun(store, runId);
  if (!['awaiting-release-approval', 'accepted'].includes(run.state)) throw new FactoryError('STATE', `run ${runId} is ${run.state}, not ready for release`);
  if (run.unsafe?.length) throw new FactoryError('UNSAFE', `run ${runId} switched off ${run.unsafe.join(', ')} for testing and can never be released`);
  const ws = run.ws;
  const proof = fs.readFileSync(path.join(store.runsDir, runId, 'proof-pack.md'), 'utf8');
  fs.mkdirSync(path.join(ws, 'docs', 'factory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'factory', `${runId}.md`), proof);
  const branch = `factory/${runId}`;
  git(ws, ['switch', '-c', branch]);
  git(ws, ['add', '-A', '--', '.', `:(exclude)${FACTORY_DIR}`]);
  const email = git(run.targetDir, ['config', 'user.email'], { allowFail: true }) || 'factory@localhost';
  const trailer = config.policy.attribution.trailer;
  const message = [`${run.taskTitle} [${run.taskId}]`, '', `Produced by principled-factory run ${runId}; evidence in docs/factory/${runId}.md.`, '',
    `${trailer}: ${run.models?.builder ?? config.factory.agent.model} via principled-factory`, `Factory-Run: ${runId}`,
    ...(approvers.length ? approvers.map((a) => `Approved-by: ${a}`) : [`Auto-released-for: ${run.requestedBy} (tier auto)`])].join('\n');
  git(ws, ['-c', `user.name=${approvers[0] ?? run.requestedBy}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message]);
  const commit = git(ws, ['rev-parse', 'HEAD']);
  removeWorkspace(run.targetDir, ws);
  run.release = { branch, commit, rollbackTarget: run.base, by, approvers, at: nowIso(), pushed: false };
  transition(store, run, 'released', { branch, commit, rollbackTarget: run.base });
  recordRelease(store, run.changeClass, config.factory.autonomy.promoteAfter ?? 5);
  return run;
}

// An escaped defect: recorded, linked to its run, and fed back into autonomy and improvement.
export function recordIncidentForRun({ store, runId, by, summary }) {
  const run = loadRun(store, runId);
  if (run.state !== 'released') throw new FactoryError('STATE', `run ${runId} was not released`);
  const incident = { id: newId('inc'), runId, changeClass: run.changeClass, by, summary, at: nowIso() };
  appendJsonLine(store.incidents, incident);
  appendEvent(store, runId, 'incident', incident);
  const autonomy = recordIncident(store, run.changeClass);
  return { incident, autonomy };
}
