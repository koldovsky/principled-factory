// Confinement (principles 4.2, 5.2): commands that run code the agent wrote (tests, observe commands) run under Node's
// permission model, limited to the workspace, and the holdout evaluator, which imports the candidate, may only read.
// Measured on Node 24.18 (BUILDLOG.md): reads and writes outside the grants, links, child processes, workers, addons, WASI
// and the inspector are denied. node:sqlite bypasses the model, so it is switched off. Test files run in the test runner's
// own process: a child per file would need --allow-child-process, and a child process is outside the model. Network access
// is not restricted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactoryError, runProcess, scrubEnv } from './util.mjs';

// Relative grants resolve against the start directory, so the command reads the same in the map, the builder's allowlist
// and the factory's own runs. The start directory must be the workspace's real path (see runTestCommand).
export const NODE_PERMISSION = ['--permission', '--allow-fs-read=.', '--allow-fs-write=.', '--no-experimental-sqlite'];
// Node 23.6 renamed this flag to --test-isolation; Node 22 knows only the experimental name, which Node 24 still accepts.
const IN_PROCESS_TESTS = '--experimental-test-isolation=none';
// Options that would widen or undo the confinement if a profile carried them. Env and config files count: they can set
// NODE_OPTIONS or permission flags from a file inside the workspace, which confined code may write.
const UNCONFINING = /^--(allow-|no-permission$|experimental-sqlite$|(experimental-)?test-isolation|env-file|experimental-(default-)?config-file)/;

export function confineArgv(argv) {
  if (argv[0] !== 'node') throw new FactoryError('CONFIG', `only node commands can be confined: ${argv.join(' ')}`);
  const widening = argv.slice(1).filter((a) => UNCONFINING.test(a));
  if (widening.length) throw new FactoryError('CONFIG', `${argv.join(' ')} carries ${widening.join(' ')}, which would undo its confinement`);
  return ['node', ...NODE_PERMISSION, ...(argv.includes('--test') ? [IN_PROCESS_TESTS] : []), ...argv.slice(1)];
}

export const confineCommand = (command) => confineArgv(command.trim().split(/\s+/)).join(' ');

// The holdout evaluator imports the candidate into its own process, next to the hidden scenarios (src/gates/holdout.mjs).
// It may read its own directory and the workspace, and write nothing: not the workspace, which the next attempt starts
// from, and not the store. It starts in an empty scratch directory, so the grants are absolute real paths.
export function confineEvaluator({ evaluator, ws }) {
  const entry = fs.realpathSync.native(evaluator);
  return ['node', '--permission', `--allow-fs-read=${path.dirname(entry)}`, `--allow-fs-read=${fs.realpathSync.native(ws)}`,
    '--no-experimental-sqlite', entry];
}

// A profile that declares confinement gets every command confined: the test command, the builder's allowlist and the
// observe commands. A command it cannot confine is refused rather than run unconfined.
export function confineProfile(profile) {
  if (profile.confine !== 'node-permission') return profile;
  return {
    ...profile,
    confined: true,
    commands: Object.fromEntries(Object.entries(profile.commands).map(([name, c]) => [name, { ...c, argv: confineArgv(c.argv) }])),
    ...(profile.bashAllow ? { bashAllow: profile.bashAllow.map(confineCommand) } : {}),
    ...(profile.observe ? { observe: Object.fromEntries(Object.entries(profile.observe).map(([name, c]) => [name, confineCommand(c)])) } : {}),
  };
}

// The probe runs as confined code would: it must be able to use the workspace, and every escape must fail. The link
// attempt follows CVE-2025-55130: a relative symlink whose target looks inside the workspace from the current directory.
const PROBE = `import fs from 'node:fs';
const result = {};
const attempt = async (name, fn) => { try { await fn(); result[name] = 'allowed'; } catch (error) { result[name] = error.code ?? error.name; } };
await attempt('workspace', () => { fs.writeFileSync('inside.txt', 'x'); fs.readFileSync('inside.txt'); });
await attempt('read', () => fs.readFileSync('../outside/secret.txt'));
await attempt('write', () => fs.writeFileSync('../outside/written.txt', 'x'));
await attempt('link', () => { fs.mkdirSync('sub'); process.chdir('sub'); fs.symlinkSync('../outside', '../link', 'dir'); fs.readFileSync('../link/secret.txt'); });
await attempt('child-process', async () => (await import('node:child_process')).execFileSync(process.execPath, ['-e', '0']));
await attempt('sqlite', () => import('node:sqlite'));
console.log(JSON.stringify(result));
`;
const ESCAPES = { read: 'reading outside the workspace', write: 'writing outside the workspace', link: 'a symlink out of the workspace',
  'child-process': 'starting a child process', sqlite: 'node:sqlite, which the permission model does not cover' };

export async function probeConfinement({ argv = confineArgv(['node', 'probe.mjs']) } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-confine-')));
  try {
    const ws = path.join(root, 'ws');
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(ws, 'probe.mjs'), PROBE);
    const res = await runProcess({ command: argv[0], args: argv.slice(1), cwd: ws, env: scrubEnv(), timeoutMs: 60_000 });
    let result = null;
    try { result = JSON.parse(res.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    const problems = !result ? [`the probe did not report (${res.stderr.trim().split('\n')[0] || `exit ${res.exitCode}`})`] : [
      ...(result.workspace === 'allowed' ? [] : [`the workspace itself was not usable (${result.workspace})`]),
      ...Object.entries(ESCAPES).filter(([p]) => result[p] === 'allowed').map(([, label]) => `${label} was allowed`),
    ];
    return { ok: !problems.length, problems, result };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
