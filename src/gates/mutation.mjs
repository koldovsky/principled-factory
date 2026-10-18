// Mutation gate (principle 4.5, «test the tests»): apply small textual mutants to the changed lines and require the
// visible tests to notice. A surviving mutant means the tests do not pin that behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, isInside } from '../util.mjs';
import { FAIL, NOT_EARNED, PASS, gateResult } from './result.mjs';

const isIdent = (c) => c !== undefined && /[\w$]/.test(c);
const wholeWord = (len) => (t, i) => !isIdent(t[i - 1]) && t[i - 1] !== '.' && t[i - 1] !== '#' && !isIdent(t[i + len]);

// Fixed order keeps generation deterministic. `pad`: leading spaces matched but not part of the operator (column).
// `chain`: a removed call takes a preceding optional-chaining '?' with it (x?.trim() → x, never the syntax error x?).
const OPERATORS = [
  { label: "'===' → '!=='", find: '===', to: '!==' },
  { label: "'!==' → '==='", find: '!==', to: '===' },
  { label: "'==' → '!='", find: '==', to: '!=', ok: (t, i) => t[i - 1] !== '=' && t[i - 1] !== '!' && t[i + 2] !== '=' },
  { label: "'!=' → '=='", find: '!=', to: '==', ok: (t, i) => t[i + 2] !== '=' },
  { label: "'&&' → '||'", find: '&&', to: '||' },
  { label: "'||' → '&&'", find: '||', to: '&&' },
  { label: "'>=' → '<'", find: ' >= ', to: ' < ', pad: 1 },
  { label: "'<=' → '>'", find: ' <= ', to: ' > ', pad: 1 },
  { label: "'>' → '<='", find: ' > ', to: ' <= ', pad: 1 },
  { label: "'<' → '>='", find: ' < ', to: ' >= ', pad: 1 },
  { label: "'true' → 'false'", find: 'true', to: 'false', ok: wholeWord(4) },
  { label: "'false' → 'true'", find: 'false', to: 'true', ok: wholeWord(5) },
  { label: "'.trim()' → ''", find: '.trim()', to: '', chain: true },
  { label: "'.toLowerCase()' → ''", find: '.toLowerCase()', to: '', chain: true },
];
const REGEX_GLOBAL = "'/g' → '/'";

const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^');
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

// Heuristic: does a '/' after the last significant code character start a regex literal rather than divide?
function regexAllowed(text, last) {
  if (last < 0) return true;
  const c = text[last];
  if (REGEX_AFTER.has(c)) return true;
  if (!isIdent(c)) return false;
  let s = last;
  while (s > 0 && isIdent(text[s - 1])) s--;
  return text[s - 1] !== '.' && REGEX_KEYWORDS.has(text.slice(s, last + 1));
}

// Best-effort lexer. Marks code characters (outside strings, template text, comments and regex bodies) and records
// regex literals carrying the g flag. ' and " strings end at the line end; templates may span lines and nest via ${}.
function scan(source) {
  const text = `${source}\n`; // a final newline lets an unclosed "regex" fall back to division
  const code = new Uint8Array(text.length);
  const globals = []; // { slash, flag } of each regex literal with a g flag
  const exprDepth = []; // open braces inside each template ${ … } we are in
  let state = text.startsWith('#!') ? 'line' : 'code';
  let quote = '';
  let last = -1;
  let regexStart = -1;
  let inClass = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === "'" || ch === '"') { state = 'str'; quote = ch; }
      else if (ch === '`') state = 'tpl';
      else if (ch === '/' && next === '/') { state = 'line'; i++; }
      else if (ch === '/' && next === '*') { state = 'block'; i++; }
      else if (ch === '/' && regexAllowed(text, last)) { state = 'regex'; regexStart = i; inClass = false; }
      else if (ch === '}' && exprDepth.at(-1) === 0) { exprDepth.pop(); state = 'tpl'; }
      else {
        if (exprDepth.length && ch === '{') exprDepth[exprDepth.length - 1]++;
        if (exprDepth.length && ch === '}') exprDepth[exprDepth.length - 1]--;
        code[i] = 1;
        if (!/\s/.test(ch)) last = i;
      }
    } else if (state === 'str') {
      if (ch === '\\') i++;
      else if (ch === quote || ch === '\n') { state = 'code'; last = i; }
    } else if (state === 'tpl') {
      if (ch === '\\') i++;
      else if (ch === '`') { state = 'code'; last = i; }
      else if (ch === '$' && next === '{') { exprDepth.push(0); state = 'code'; last = ++i; }
    } else if (state === 'line') {
      if (ch === '\n') state = 'code';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i++; }
    } else if (ch === '\n') {
      // Regex state. A regex literal cannot span lines: it was a division after all, rescan from after the slash.
      code[regexStart] = 1;
      last = regexStart;
      i = regexStart;
      state = 'code';
    } else if (ch === '\\') i++;
    else if (inClass) inClass = ch !== ']';
    else if (ch === '[') inClass = true;
    else if (ch === '/') {
      let end = i + 1;
      while (isIdent(text[end])) end++;
      const flag = text.indexOf('g', i + 1);
      if (flag !== -1 && flag < end) globals.push({ slash: i, flag });
      last = end - 1;
      i = end - 1;
      state = 'code';
    }
  }
  return { code, globals };
}

// All candidates of one file in line/column order; `lines` (a Set of 1-based numbers) restricts them when given.
function fileCandidates(file, source, lines) {
  const { code, globals } = scan(source);
  const out = [];
  let offset = 0;
  source.split('\n').forEach((raw, n) => {
    const start = offset;
    offset += raw.length + 1;
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (lines && !lines.has(n + 1)) return;
    const head = text.trimStart();
    if (head.startsWith('//') || head.startsWith('/*') || head.startsWith('*')) return;
    const isCode = (from, end) => {
      for (let k = from; k < end; k++) if (!code[start + k]) return false;
      return true;
    };
    const add = (from, end, to, operator, column) => out.push({
      file, line: n + 1, column, operator, original: text, mutated: text.slice(0, from) + to + text.slice(end),
    });
    for (const op of OPERATORS) {
      for (let at = text.indexOf(op.find); at !== -1; at = text.indexOf(op.find, at + 1)) {
        const from = op.chain && text[at - 1] === '?' ? at - 1 : at;
        const end = at + op.find.length;
        if (isCode(from, end) && (!op.ok || op.ok(text, at))) add(from, end, op.to, op.label, from + (op.pad ?? 0) + 1);
      }
    }
    for (const { slash, flag } of globals) {
      if (slash >= start && slash < start + text.length) add(flag - start, flag - start + 1, '', REGEX_GLOBAL, slash - start + 1);
    }
  });
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

const toPosix = (p) => path.posix.normalize(String(p).replaceAll('\\', '/'));

function lineFilter(changedLines) {
  if (!changedLines) return null;
  const entries = changedLines instanceof Map ? [...changedLines] : Object.entries(changedLines);
  return new Map(entries.map(([file, lines]) => [toPosix(file), new Set([...(lines ?? [])].map(Number))]));
}

// Per-file quotas come from plain round-robin over the files; within a file the picks are evenly spaced
// (index floor(i * n / quota)) so a small budget samples the whole change, not just its first lines.
// The result is interleaved round by round: first pick of every file, then the second picks, and so on.
function roundRobin(groups, maxMutants) {
  const quota = groups.map(() => 0);
  let left = Math.max(0, Math.floor(maxMutants)) || 0;
  for (let round = 0; left > 0; round++) {
    let took = false;
    for (let f = 0; f < groups.length && left > 0; f++) {
      if (groups[f].length > round) { quota[f]++; left--; took = true; }
    }
    if (!took) break;
  }
  const picks = groups.map((g, f) => Array.from({ length: quota[f] }, (_, i) => g[Math.floor((i * g.length) / quota[f])]));
  const out = [];
  for (let round = 0; picks.some((p) => p.length > round); round++) {
    for (const p of picks) if (p.length > round) out.push(p[round]);
  }
  return out;
}

// files: repo-relative paths of source files (tests excluded by the caller). changedLines: { file: [1-based lines] };
// when given, only those lines (of those files) are mutated. Deterministic for the same input and file contents.
export function generateMutants({ root, files, changedLines, maxMutants = 10 }) {
  const only = lineFilter(changedLines);
  const groups = [];
  for (const file of [...new Set((files ?? []).map(toPosix))].sort()) {
    const lines = only ? only.get(file) : null;
    if (only && !lines?.size) continue;
    const abs = path.join(root, file);
    if (!isInside(abs, root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const bytes = fs.readFileSync(abs);
    if (bytes.includes(0)) continue; // binary
    const candidates = fileCandidates(file, bytes.toString('utf8'), lines);
    if (candidates.length) groups.push(candidates);
  }
  return roundRobin(groups, maxMutants);
}

// Replace one line and keep every other byte, line endings included.
function applyMutant(source, mutant) {
  const rows = source.split('\n');
  const raw = rows[mutant.line - 1] ?? '';
  const cr = raw.endsWith('\r') ? '\r' : '';
  if (raw.slice(0, raw.length - cr.length) !== mutant.original) {
    throw new Error(`${mutant.file}:${mutant.line} no longer matches the line the mutant was made from`);
  }
  rows[mutant.line - 1] = mutant.mutated + cr;
  return rows.join('\n');
}

// Put the original bytes back (skipped when they are already there, e.g. the mutant write itself failed), retrying
// briefly because Windows may hold a transient lock. Failing to restore must be loud.
async function restore(file, bytes) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
      return;
    } catch (error) {
      if (attempt === 5) throw new FactoryError('mutation-restore-failed', `could not restore ${file} after a mutant: ${error.message}`, { file });
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

const clip = (s, max = 120) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

// runTests() runs the visible tests against `root` and resolves to { passed: boolean }; it is called once per mutant
// with the mutated file in place. Precondition: the visible tests pass on the unmutated code (an already red suite
// would "kill" every mutant).
export async function runMutation({ root, files, changedLines, maxMutants = 10, minScore = 0.6, runTests }) {
  const started = Date.now();
  if (typeof runTests !== 'function') throw new TypeError('runMutation needs a runTests callback');
  if (!(minScore >= 0 && minScore <= 1)) throw new RangeError(`minScore must be between 0 and 1, got ${minScore}`);
  const result = (verdict, summary, remediation, evidence) =>
    gateResult({ id: 'mutation', verdict, summary, remediation, evidence, durationMs: Date.now() - started });

  const mutants = generateMutants({ root, files, changedLines, maxMutants });
  if (!mutants.length) {
    return result(NOT_EARNED, 'no mutants generated (no mutable operators on the changed lines), so test strength was not verified',
      null, { total: 0, killed: 0, errors: 0, score: null, minScore, survived: [], errored: [] });
  }

  const originals = new Map();
  const survived = [];
  const errored = [];
  let killed = 0;
  for (const mutant of mutants) {
    const abs = path.join(root, mutant.file);
    let bytes;
    try {
      if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs));
      bytes = originals.get(abs);
      fs.writeFileSync(abs, applyMutant(bytes.toString('utf8'), mutant));
      const outcome = await runTests();
      if (typeof outcome?.passed !== 'boolean') throw new Error('runTests must resolve to { passed: boolean }');
      if (outcome.passed) survived.push(mutant);
      else killed++;
    } catch (error) {
      errored.push({ ...mutant, error: String(error?.message ?? error) });
    } finally {
      if (bytes) await restore(abs, bytes);
    }
  }

  const total = mutants.length;
  const errors = errored.length;
  const score = killed / total;
  const evidence = { total, killed, errors, score, minScore, survived, errored };
  const ratio = `${killed}/${total} mutants killed${errors ? `, ${errors} errored` : ''} (score ${score.toFixed(2)}, minimum ${minScore})`;
  if (score >= minScore) return result(PASS, ratio, null, evidence);
  // Errors are not kills, but FAIL needs survivors to blame: when counting the errors as kills would pass, it is unproven.
  if ((killed + errors) / total >= minScore) {
    return result(NOT_EARNED, `${errors} of ${total} mutants could not be evaluated (${clip(errored[0].error)}), so test strength is unproven: ${ratio}`,
      null, evidence);
  }
  const advice = survived.slice(0, 3).map((m) => `add a test that fails when ${m.operator} is applied at ${m.file}:${m.line} (${clip(m.original.trim())})`);
  if (survived.length > 3) advice.push(`(${survived.length - 3} more survivors in the evidence)`);
  return result(FAIL, `${survived.length} of ${total} mutants survived, so the tests do not pin the changed behaviour: ${ratio}`,
    advice.join('\n'), evidence);
}
