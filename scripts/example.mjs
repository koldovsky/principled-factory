// Sets up the slug example in a scratch directory: a git target, a copy of control, an empty store,
// a passing readiness check, and human approvals of the configuration and the task intent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/util.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadTask } from '../src/task.mjs';
import { openStore } from '../src/store.mjs';
import { recordApproval } from '../src/approvals.mjs';
import { doctor } from '../src/doctor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function setupExample({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-')), approver = 'alice', approve = true, mutateControl, mutateTarget } = {}) {
  const target = path.join(dir, 'target');
  const control = path.join(dir, 'control');
  const store = path.join(dir, 'store');
  fs.cpSync(path.join(ROOT, 'examples', 'slug', 'target'), target, { recursive: true });
  fs.cpSync(path.join(ROOT, 'examples', 'slug', 'control'), control, { recursive: true });
  if (mutateControl) mutateControl(control);
  if (mutateTarget) mutateTarget(target, control);
  git(target, ['init', '-q', '-b', 'main']);
  git(target, ['-c', 'user.name=Example', '-c', 'user.email=example@localhost', 'add', '-A']);
  git(target, ['-c', 'user.name=Example', '-c', 'user.email=example@localhost', 'commit', '-q', '-m', 'Initial slug example']);
  git(target, ['config', 'user.email', 'example@localhost']);
  const s = openStore(store);
  let readiness = null;
  if (approve) {
    const config = loadConfig(control);
    recordApproval(s, { kind: 'config', subject: 'factory', digest: config.digest, by: approver }, config.policy);
    for (const t of fs.readdirSync(path.join(control, 'tasks'))) {
      const id = t.replace(/\.json$/, '');
      recordApproval(s, { kind: 'intent', subject: id, digest: loadTask(control, id).digest, by: approver }, config.policy);
    }
    readiness = await doctor({ controlDir: control, targetDir: target, storeDir: store });
  }
  return { dir, target, control, store, readiness, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
