// Disposable workspaces (principle 5.2): a detached git worktree of the target per run. The builder never sees
// the target's checked-out branch, the control directory or the store; diffs, patches and release branches are git-native.
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, git, hashFile, listFiles, matchesAny } from './util.mjs';

export const FACTORY_DIR = '.factory';
const EXCLUDE = `:(exclude)${FACTORY_DIR}`;

export function assertGitRepo(target) {
  const inside = git(target, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (inside !== 'true') throw new FactoryError('NOT_GIT', `${target} is not a git repository; the factory needs version control for diffs, rollback and release branches`);
}

export function createWorkspace(target, wsDir) {
  assertGitRepo(target);
  const base = git(target, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.dirname(wsDir), { recursive: true });
  git(target, ['worktree', 'add', '--detach', wsDir, base]);
  return { base };
}

export function removeWorkspace(target, wsDir) {
  if (fs.existsSync(wsDir)) git(target, ['worktree', 'remove', '--force', wsDir], { allowFail: true });
  if (fs.existsSync(wsDir)) fs.rmSync(wsDir, { recursive: true, force: true });
  git(target, ['worktree', 'prune'], { allowFail: true });
}

// Hashes of every protected file at workspace creation (tests, specs, factory files).
export function protectedManifest(ws, globs) {
  const files = listFiles(ws).filter((f) => matchesAny(f, globs));
  return Object.fromEntries(files.map((f) => [f, hashFile(path.join(ws, f))]));
}

// Stage everything except the factory's own files and describe the change against the base commit.
export function describeChange(ws, base) {
  git(ws, ['add', '-A', '--', '.', EXCLUDE]);
  const numstat = git(ws, ['diff', '--cached', '--numstat', base, '--', '.', EXCLUDE]);
  const files = numstat ? numstat.split('\n').map((line) => {
    const [added, removed, file] = line.split('\t');
    return { file, added: Number(added) || 0, removed: Number(removed) || 0 };
  }) : [];
  const patch = git(ws, ['diff', '--cached', '--binary', base, '--', '.', EXCLUDE]);
  const changedLines = {};
  let current = null;
  for (const line of git(ws, ['diff', '--cached', '-U0', base, '--', '.', EXCLUDE]).split('\n')) {
    if (line.startsWith('+++ b/')) { current = line.slice(6); changedLines[current] = []; }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) changedLines[current].push(start + i);
    }
  }
  return { files, patch, changedLines, linesChanged: files.reduce((n, f) => n + f.added + f.removed, 0) };
}

export function readChangedContents(ws, files) {
  const out = {};
  for (const { file } of files) {
    const abs = path.join(ws, file);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out[file] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}
