// Readiness (principle 7.3): before agents touch a target, its delivery basics must hold.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { writeReadiness } from './pipeline.mjs';
import { createWorkspace, removeWorkspace } from './workspace.mjs';
import { runTestCommand } from './gates/deterministic.mjs';
import { git, newId, resolveExecutable } from './util.mjs';
import os from 'node:os';

export async function doctor({ controlDir, targetDir, storeDir }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const config = loadConfig(controlDir);
  const isGit = git(targetDir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
  add('git', isGit, isGit ? 'target is a git repository (diffs, rollback, release branches)' : 'target is not a git repository');
  if (isGit) {
    const dirty = git(targetDir, ['status', '--porcelain'], { allowFail: true });
    add('clean', !dirty, dirty ? 'uncommitted changes: agents work from the last commit, so commit or stash first' : 'working tree clean');
  }
  const ci = ['.github/workflows', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile'].some((p) => fs.existsSync(path.join(targetDir, p)));
  add('ci', ci, ci ? 'CI configuration present' : 'no CI configuration found: changes would not be re-verified after release');
  for (const [name, cmd] of Object.entries(config.profile.commands)) {
    let ok = true;
    try { resolveExecutable(cmd.argv[0]); } catch { ok = false; }
    add(`command:${name}`, ok, ok ? `${cmd.argv[0]} is available` : `${cmd.argv[0]} not found`);
  }
  if (isGit && checks.every((c) => c.ok)) {
    const ws = path.join(os.tmpdir(), newId('factory-doctor'));
    try {
      createWorkspace(targetDir, ws);
      const a = await runTestCommand({ ws, profile: config.profile });
      const b = await runTestCommand({ ws, profile: config.profile });
      const sig = (r) => r.tests.map((t) => `${t.name}:${t.ok}`).sort().join('|') + `#${r.exitCode}`;
      add('deterministic-tests', sig(a) === sig(b), sig(a) === sig(b) ? `test outcomes identical across two runs (${a.tests.length} tests)` : 'test outcomes differ between runs: fix flaky tests before adding agents');
    } finally {
      removeWorkspace(targetDir, ws);
    }
  }
  const ok = checks.every((c) => c.ok);
  const record = { ok, target: path.resolve(targetDir), head: isGit ? git(targetDir, ['rev-parse', 'HEAD']) : null, checks };
  writeReadiness(openStore(storeDir), record);
  return record;
}
