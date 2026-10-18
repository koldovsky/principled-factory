// Shared helpers: hashing, atomic JSON, path containment, bounded processes, environment scrubbing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  if (fallback !== undefined && !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Write to a temporary file in the same directory, then rename, so readers never see a half-written file.
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameWithRetry(tmp, file);
}

// Windows can refuse a rename for a moment while another process (a reader, an indexer, antivirus) holds the target open.
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!IS_WIN || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || i >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (i + 1));
    }
  }
}

export function appendJsonLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Canonical form of a path for containment checks: absolute, resolved through existing symlinks/junctions,
// \\?\ prefix stripped, case-folded on Windows.
export function canonicalPath(p) {
  let abs = path.resolve(String(p).replace(/^\\\\\?\\/, ''));
  let existing = abs;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try { real = fs.realpathSync.native(existing); } catch { /* keep resolved path */ }
  const full = path.join(real, ...tail);
  return IS_WIN ? full.toLowerCase() : full;
}

// True when `child` is `parent` itself or lies inside it.
export function isInside(child, parent) {
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Glob → RegExp for repository-relative paths with forward slashes. Supports **, *, ?.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, IS_WIN ? 'i' : '');
}

export function matchesAny(relPath, globs = []) {
  const p = relPath.replaceAll('\\', '/');
  return globs.some((g) => globToRegExp(g).test(p));
}

// All files under `dir` as repository-relative forward-slash paths, skipping the given directory names.
export function listFiles(dir, { skipDirs = ['.git', 'node_modules'] } = {}) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) walk(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile()) out.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

export function treeDigest(dir, files) {
  const lines = files.map((f) => `${f}\0${hashFile(path.join(dir, f))}`);
  return sha256(lines.join('\n'));
}

const ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|LANG|LC_ALL|TERM)$/i;

// Least-privilege environment: only what processes need to run, plus explicitly named extras.
export function scrubEnv(extra = {}, { keepPatterns = [] } = {}) {
  const keep = (k) => ENV_KEEP.test(k) || keepPatterns.some((re) => re.test(k));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep(k)));
  return { ...env, ...extra };
}

// Resolve an executable on PATH. Shell wrappers (.cmd/.bat) are refused: arguments would pass through a shell.
export function resolveExecutable(name) {
  if (path.isAbsolute(name)) return name;
  if (name === 'node') return process.execPath;
  const exts = IS_WIN ? ['.exe', '.com', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    if (IS_WIN && ['.cmd', '.bat'].some((e) => fs.existsSync(path.join(dir, name + e)))) {
      throw new Error(`${name} resolves to a shell wrapper (.cmd/.bat); configure the real executable path instead`);
    }
  }
  throw new Error(`executable not found on PATH: ${name}`);
}

function killTree(child) {
  if (!child.pid) return;
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
}

// Run a process with an argument array (never a shell), a deadline and bounded output.
// `shouldStop` is polled every 500 ms; returning true kills the process tree (kill switch).
export function runProcess({ command, args = [], cwd, env, stdin, timeoutMs = 600_000, maxOutput = 4_000_000, shouldStop }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let reason = null;
    let child;
    try {
      child = spawn(resolveExecutable(command), args, {
        cwd, env, shell: false, windowsHide: true, detached: !IS_WIN,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ status: 'error', exitCode: null, stdout: '', stderr: String(error.message), durationMs: 0 });
      return;
    }
    const finish = (status, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ status, exitCode, stdout, stderr, durationMs: Date.now() - started, reason });
    };
    const timer = setTimeout(() => { reason = 'timeout'; killTree(child); }, timeoutMs);
    const poll = setInterval(() => {
      if (shouldStop && shouldStop()) { reason = 'stopped'; killTree(child); }
    }, 500);
    child.stdout.on('data', (d) => { if (stdout.length < maxOutput) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < maxOutput) stderr += d; });
    child.on('error', (error) => { stderr += String(error.message); finish('error', null); });
    child.on('close', (code) => finish(reason ?? (code === 0 ? 'completed' : 'failed'), code));
    if (stdin !== undefined) {
      child.stdin.on('error', () => { /* process may exit before reading */ });
      child.stdin.end(stdin);
    }
  });
}

export function git(cwd, args, opts = {}) {
  const res = spawnSync(resolveExecutable('git'), args, { cwd, encoding: 'utf8', windowsHide: true, ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return (res.stdout ?? '').trim();
}

export class FactoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
