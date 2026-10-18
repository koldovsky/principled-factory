// Maintainability gate (principle 4.7): file-size, dependency-direction and duplication sensors for JS/TS sources.
import fs from 'node:fs';
import path from 'node:path';
import { FAIL, NOT_EARNED, PASS, gateResult } from './result.mjs';
import { globToRegExp, listFiles, sha256 } from '../util.mjs';

const ID = 'maintainability';
const DEFAULT_SOURCE_GLOBS = ['**/*.mjs', '**/*.js', '**/*.cjs', '**/*.ts'];
const DEFAULT_MIN_LINES = 6;
const MIN_WINDOW_CHARS = 60;
const SKIP_DIRS = ['.git', 'node_modules'];
const EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts'];
const INDEX_FILES = ['index.mjs', 'index.js', 'index.ts'];
const RULE_NAMES = ['max-file-lines', 'dependency', 'duplication'];
const PREVIEW = 5;

const splitFix = (max) => `Split it into smaller modules with one responsibility each (move cohesive groups of functions into new files and import them) so that no file exceeds ${max} lines.`;
const layerFix = (from) => `Remove this import: reach that code through a module that ${from} may depend on, or move the logic to the layer that owns it.`;
const EXTRACT_FIX = 'Extract the repeated code into one shared function or module and call it from every place that needs it, instead of keeping copies.';

// rules: { maxFileLines?, dependencyRules?: [{ from, mustNotImport, reason, remediation? }], duplication?: { minLines? },
// sourceGlobs? }. An invalid rule entry is reported and never passes silently: without findings the result is NOT-EARNED.
export function checkMaintainability({ root, files = [], rules = {} } = {}) {
  const started = Date.now();
  if (!root) throw new TypeError('checkMaintainability needs the root directory of the candidate code');
  const cfg = readRules(rules);
  const invalid = cfg.problems.length ? ` Invalid rules ignored: ${cfg.problems.join('; ')}.` : '';
  const result = (verdict, summary, remediation, findings = [], checkedFiles = []) => gateResult({
    id: ID, verdict, summary: summary + invalid, remediation,
    evidence: { findings, checkedFiles, checks: cfg.checks },
    durationMs: Date.now() - started,
  });
  if (!cfg.checks.length) {
    return result(NOT_EARNED, 'Maintainability not verified: no maintainability rule is configured.',
      'Configure maxFileLines, dependencyRules or duplication in the maintainability rules so this gate verifies something.');
  }

  const isSource = matcher(cfg.sourceGlobs);
  const sources = new Map();
  const load = (file) => {
    if (!sources.has(file)) sources.set(file, readSource(root, file));
    return sources.get(file);
  };
  const given = [...new Set((Array.isArray(files) ? files : []).map(cleanPath).filter(Boolean))];
  const checked = given.filter((f) => isSource(f) && isFile(path.join(root, f)) && load(f)).sort();
  if (!checked.length) {
    return result(NOT_EARNED,
      `Maintainability not verified: none of the ${plural(given.length, 'given file')} is an existing source file matching ${cfg.sourceGlobs.join(', ') || '(empty sourceGlobs)'}.`,
      'Nothing was analysed: pass the changed source files, or adjust sourceGlobs if these files should be checked.');
  }

  const findings = [];
  const resolve = resolver(root);
  for (const file of checked) {
    const source = load(file);
    if (cfg.maxFileLines && source.lineCount > cfg.maxFileLines) findings.push(sizeFinding(file, source.lineCount, cfg.maxFileLines));
    for (const rule of cfg.dependencyRules) findings.push(...dependencyFindings(file, source, rule, resolve));
  }
  if (cfg.minLines) findings.push(...duplicationFindings(root, checked, cfg.minLines, isSource, load));
  const order = new Map(checked.map((f, i) => [f, i]));
  findings.sort((a, b) => order.get(a.file) - order.get(b.file) || a.line - b.line
    || RULE_NAMES.indexOf(a.rule) - RULE_NAMES.indexOf(b.rule));

  if (findings.length) {
    const counts = RULE_NAMES.map((r) => [r, findings.filter((f) => f.rule === r).length]).filter(([, n]) => n);
    const preview = findings.slice(0, PREVIEW).map((f) => `- ${f.message}`);
    if (findings.length > PREVIEW) preview.push(`- ...and ${findings.length - PREVIEW} more in evidence.findings.`);
    return result(FAIL,
      `Maintainability failed: ${plural(findings.length, 'finding')} in ${plural(checked.length, 'checked file')} (${counts.map(([r, n]) => `${n} ${r}`).join(', ')}).`,
      preview.join('\n'), findings, checked);
  }
  if (cfg.problems.length) {
    return result(NOT_EARNED, `Maintainability not verified: no findings in ${plural(checked.length, 'checked file')}, but not every configured rule could be applied.`,
      'Fix the invalid maintainability rules so that every configured rule is actually checked.', [], checked);
  }
  return result(PASS, `Maintainability passed: no findings in ${plural(checked.length, 'checked file')} (${cfg.checks.join(', ')}).`,
    null, [], checked);
}

function readRules(rules) {
  const r = rules ?? {};
  const problems = [];
  let maxFileLines = null;
  if (r.maxFileLines != null) {
    if (Number.isFinite(r.maxFileLines) && r.maxFileLines > 0) maxFileLines = r.maxFileLines;
    else problems.push('maxFileLines must be a positive number');
  }
  if (r.dependencyRules != null && !Array.isArray(r.dependencyRules)) problems.push('dependencyRules must be an array');
  const dependencyRules = [];
  (Array.isArray(r.dependencyRules) ? r.dependencyRules : []).forEach((rule, i) => {
    const parsed = dependencyRule(rule);
    if (parsed) dependencyRules.push(parsed);
    else problems.push(`dependencyRules[${i}] needs from and mustNotImport globs`);
  });
  let minLines = null;
  if (r.duplication) {
    const m = r.duplication.minLines;
    minLines = m === undefined ? DEFAULT_MIN_LINES : Number.isInteger(m) && m > 0 ? m : null;
    if (!minLines) problems.push('duplication.minLines must be a positive integer');
  }
  const sourceGlobs = r.sourceGlobs == null ? DEFAULT_SOURCE_GLOBS : globList(r.sourceGlobs);
  const checks = [maxFileLines && 'max-file-lines', dependencyRules.length && 'dependency', minLines && 'duplication'].filter(Boolean);
  return { maxFileLines, dependencyRules, minLines, sourceGlobs, checks, problems };
}

function dependencyRule(rule) {
  const from = globList(rule?.from);
  const banned = globList(rule?.mustNotImport);
  if (!from.length || !banned.length) return null;
  return {
    from: from.join(', '),
    appliesTo: matcher(from),
    banned: banned.map((glob) => ({ glob, re: globToRegExp(glob) })),
    reason: String(rule.reason ?? '').trim().replace(/[.\s]+$/, ''),
    remediation: String(rule.remediation ?? '').trim(),
  };
}

function finding(rule, file, line, problem, remediation) {
  return { rule, file, line, message: `${problem} ${remediation}`, remediation };
}

function sizeFinding(file, lines, max) {
  return finding('max-file-lines', file, max + 1, `${file} has ${lines} lines, over the limit of ${max}.`, splitFix(max));
}

function dependencyFindings(file, source, rule, resolve) {
  if (!rule.appliesTo(file)) return [];
  const out = [];
  for (const { specifier, line } of source.specifiers) {
    const resolved = resolve(file, specifier);
    const hit = rule.banned.find(({ re }) => re.test(resolved ?? specifier));
    if (!hit) continue;
    const ruleText = `${rule.from} must not import ${hit.glob}`;
    const why = rule.reason ? `${rule.reason} (rule: ${ruleText})` : `the rule says ${ruleText}`;
    out.push(finding('dependency', file, line, `${file}:${line} imports ${resolved ?? `'${specifier}'`}, but ${why}.`,
      rule.remediation || layerFix(rule.from)));
  }
  return out;
}

// Relative specifiers resolve to repo-relative paths (exact, then known extensions, then a directory index); when
// nothing exists the normalised path is kept. Bare specifiers return null: they are matched as written.
function resolver(root) {
  const cache = new Map();
  return (fromFile, specifier) => {
    if (!/^\.\.?(?:\/|$)/.test(specifier)) return null;
    const base = path.posix.join(path.posix.dirname(fromFile), specifier.replace(/[?#].*$/, '')).replace(/\/+$/, '') || '.';
    if (!cache.has(base)) cache.set(base, resolveBase(root, base));
    return cache.get(base);
  };
}

function resolveBase(root, base) {
  if (base === '..' || base.startsWith('../')) return base;
  const candidates = base === '.' ? INDEX_FILES
    : [base, ...EXTENSIONS.map((ext) => base + ext), ...INDEX_FILES.map((f) => `${base}/${f}`)];
  return candidates.find((c) => isFile(path.join(root, c), true)) ?? base;
}

// Duplicated code: windows of `size` consecutive normalised lines (at least MIN_WINDOW_CHARS long) that start in a
// checked file and also occur in another source file or, without overlapping, elsewhere in the same file.
// Consecutive duplicated windows form one region; copies already named in a finding are not reported again.
function duplicationFindings(root, checked, size, isSource, load) {
  const windowsOf = new Map();
  const occurrences = new Map(); // window hash → [{ file, k }]
  for (const file of new Set([...listFiles(root, { skipDirs: SKIP_DIRS }).filter(isSource), ...checked])) {
    const source = load(file);
    if (!source) continue;
    const wins = windows(source.codeLines, size);
    windowsOf.set(file, wins);
    wins.forEach((w, k) => {
      if (!w) return;
      if (!occurrences.has(w.key)) occurrences.set(w.key, []);
      occurrences.get(w.key).push({ file, k });
    });
  }
  const reported = new Set();
  const out = [];
  for (const file of checked) {
    const wins = windowsOf.get(file) ?? [];
    let run = null;
    const flush = () => {
      if (run) out.push(duplicationFinding(file, wins, run, windowsOf, size));
      run = null;
    };
    wins.forEach((w, k) => {
      const copies = w && !reported.has(`${file}\0${k}`)
        ? occurrences.get(w.key).filter((o) => o.file !== file || Math.abs(o.k - k) >= size)
        : [];
      if (!copies.length) return flush();
      if (run) run.end = k;
      else run = { start: k, end: k, copy: copies[0], copies: copies.length };
      for (const o of copies) reported.add(`${o.file}\0${o.k}`);
    });
    flush();
  }
  return out;
}

function windows(lines, size) {
  const out = [];
  for (let k = 0; k + size <= lines.length; k++) {
    const text = lines.slice(k, k + size).map((l) => l.text).join('\n');
    out.push(text.length >= MIN_WINDOW_CHARS ? { key: sha256(text), start: lines[k].line, end: lines[k + size - 1].line } : null);
  }
  return out;
}

function duplicationFinding(file, wins, run, windowsOf, size) {
  const { copy } = run;
  const other = windowsOf.get(copy.file);
  let span = 0; // how far the copy keeps matching the region, window by window
  while (span < run.end - run.start && other[copy.k + span + 1]?.key === wins[run.start + span + 1].key) span++;
  const start = wins[run.start].start;
  const total = run.end - run.start + size;
  const where = `${copy.file}:${other[copy.k].start}-${other[copy.k + span].end}`;
  const more = run.copies > 1 ? ` (and ${plural(run.copies - 1, 'more place')})` : '';
  // A region can be stitched from several copies; then name the copy of its beginning without overstating it.
  const copied = span + size === total ? `at ${where}${more}` : `found elsewhere; the first ${span + size} are at ${where}${more}`;
  return finding('duplication', file, start, `${file}:${start}-${wins[run.end].end} duplicates ${total} code lines ${copied}.`, EXTRACT_FIX);
}

// Parsed view of one source file, or null when it cannot be read.
function readSource(root, file) {
  let text;
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; }
  const { tokens, code } = lex(text);
  const { specifiers, declarationLines } = moduleReferences(tokens);
  return { lineCount: countLines(text), specifiers, codeLines: normalisedLines(code, declarationLines) };
}

function countLines(text) {
  if (!text) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

// Lines that only hold braces, brackets, parentheses, semicolons or commas carry no logic worth comparing.
const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;

// Duplication input: comments are already blanked; whitespace is collapsed; blank and punctuation-only lines are
// dropped, and so are module declarations (imports, re-exports, require declarations): shared headers are not logic.
function normalisedLines(code, skip) {
  const out = [];
  code.split('\n').forEach((raw, i) => {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (!TRIVIAL_LINE.test(text) && !skip.has(i + 1)) out.push({ text, line: i + 1 });
  });
  return out;
}

// Module specifiers (with the line of their statement) from static and side-effect imports, `export … from`,
// dynamic import() and require() with a literal argument; plus the lines taken by those declarations.
function moduleReferences(tokens) {
  const specifiers = [];
  const declarationLines = new Set();
  const is = (k, type, value) => tokens[k]?.type === type && (value === undefined || tokens[k].value === value);
  const declare = (from, to) => { for (let l = from; l <= to; l++) declarationLines.add(l); };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'name' || is(i - 1, 'punct', '.')) continue;
    if ((t.value === 'import' || t.value === 'require') && is(i + 1, 'punct', '(')) {
      if (is(i + 2, 'string') && (is(i + 3, 'punct', ')') || is(i + 3, 'punct', ','))) {
        specifiers.push({ specifier: tokens[i + 2].value, line: t.line });
        const declaration = t.value === 'require' && requireDeclaration(tokens, i);
        if (declaration) declare(declaration.line, tokens[i + 3].line);
      }
      continue;
    }
    let k = -1;
    if (t.value === 'import' && !is(i + 1, 'punct', '.')) k = is(i + 1, 'string') ? i + 1 : fromClause(tokens, i + 1);
    else if (t.value === 'export') {
      const j = is(i + 1, 'name', 'type') ? i + 2 : i + 1;
      if (is(j, 'punct', '*') || is(j, 'punct', '{')) k = fromClause(tokens, j);
    }
    if (k < 0) continue;
    specifiers.push({ specifier: tokens[k].value, line: t.line });
    declare(t.line, tokens[k].line);
  }
  return { specifiers, declarationLines };
}

// Index of the specifier in an import/export clause's `from '<specifier>'`, or -1 when the clause has none.
function fromClause(tokens, start) {
  for (let k = start; k < tokens.length - 1; k++) {
    const t = tokens[k];
    if (t.type === 'name' && t.value === 'from' && tokens[k + 1].type === 'string') return k + 1;
    if (t.type === 'punct' && ';=():'.includes(t.value)) return -1;
    if (t.type === 'name' && (t.value === 'import' || t.value === 'export')) return -1;
  }
  return -1;
}

// The `const|let|var` token of `const x = require('y')`, or null when require() is used some other way.
function requireDeclaration(tokens, i) {
  if (tokens[i - 1]?.value !== '=') return null;
  for (let k = i - 2; k >= 0 && k > i - 64; k--) {
    const t = tokens[k];
    if (t.type === 'name' && ['const', 'let', 'var'].includes(t.value)) return t;
    if (t.type === 'punct' && ';=()'.includes(t.value)) return null;
  }
  return null;
}

const NAME_START = /[\p{ID_Start}$_]/u;
const NAME_REST = /[\p{ID_Continue}$‌‍]*/uy;
const NUMBER = /\.?\d[\w.]*/y;
const SPACE = /\s/;
const REGEX_FLAG = /[\w$]/;
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await']);
const isDigit = (c) => c >= '0' && c <= '9';

// Minimal JS/TS lexer: tokens without comments, plus the text with comments blanked (newlines kept, so line numbers
// still match). Strings and regexes cannot span lines, so a misread quote or slash only disturbs its own line.
function lex(text) {
  const tokens = [];
  const comments = [];
  const depth = []; // brace depth inside each open template substitution `${ … }`
  let line = 1;
  let i = 0;
  const add = (type, value) => tokens.push({ type, value, line });
  if (text.startsWith('#!')) {
    i = lineEnd(text, 0);
    comments.push([0, i]);
  }
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    const regexEnd = ch === '/' && next !== '/' && next !== '*' && regexAllowed(tokens.at(-1)) ? regexLiteralEnd(text, i + 1) : -1;
    if (ch === '\n') {
      line++;
      i++;
    } else if (SPACE.test(ch)) {
      i++;
    } else if (ch === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? lineEnd(text, i) : blockCommentEnd(text, i);
      comments.push([i, end]);
      line += countNewlines(text, i, end);
      i = end;
    } else if (ch === '\'' || ch === '"') {
      const s = readString(text, i);
      add('string', s.value);
      line += s.newlines;
      i = s.end;
    } else if (ch === '`' || (ch === '}' && depth.at(-1) === 0)) {
      if (ch === '}') depth.pop();
      const s = readTemplate(text, i + 1);
      if (s.open) depth.push(0);
      // A template without substitutions is a plain string; otherwise only mark where substitutions open and close.
      if (ch === '`' && !s.open) add('string', s.value);
      else add('template', s.open ? 'open' : 'close');
      line += s.newlines;
      i = s.end;
    } else if (regexEnd > 0) {
      add('regex', null);
      i = regexEnd;
    } else if (NAME_START.test(ch)) {
      NAME_REST.lastIndex = i + 1;
      NAME_REST.exec(text);
      add('name', text.slice(i, NAME_REST.lastIndex));
      i = NAME_REST.lastIndex;
    } else if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      NUMBER.lastIndex = i;
      NUMBER.exec(text);
      add('number', null);
      i = NUMBER.lastIndex;
    } else {
      if (depth.length && (ch === '{' || ch === '}')) depth[depth.length - 1] += ch === '{' ? 1 : -1;
      add('punct', ch);
      i++;
    }
  }
  return { tokens, code: blankRanges(text, comments) };
}

// A slash starts a regex literal where an expression may begin, i.e. not after a value.
function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === 'punct') return !')]}'.includes(prev.value);
  if (prev.type === 'name') return BEFORE_REGEX.has(prev.value);
  return prev.type === 'template' && prev.value === 'open';
}

// End of a regex literal whose body starts at `start` (flags included), or -1 when the line ends first.
function regexLiteralEnd(text, start) {
  let inClass = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      if (text[j + 1] === '\n' || text[j + 1] === '\r') return -1;
      j++;
    } else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < text.length && REGEX_FLAG.test(text[k])) k++;
      return k;
    }
  }
  return -1;
}

function readString(text, start) {
  const quote = text[start];
  let value = '';
  let newlines = 0;
  let j = start + 1;
  while (j < text.length && text[j] !== quote && text[j] !== '\n') {
    if (text[j] === '\\') {
      if (text[j + 1] === '\r' && text[j + 2] === '\n') j++;
      if (text[j + 1] === '\n') newlines++;
      else value += text[j + 1] ?? '';
      j += 2;
    } else value += text[j++];
  }
  return { value, newlines, end: text[j] === quote ? j + 1 : j };
}

// Template text from `start` up to the closing backtick (open: false) or the next `${` (open: true).
function readTemplate(text, start) {
  let value = '';
  let newlines = 0;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (c === '`') return { value, newlines, end: j + 1, open: false };
    if (c === '$' && text[j + 1] === '{') return { value, newlines, end: j + 2, open: true };
    if (c === '\\') {
      j++;
      if (text[j] === '\n') newlines++;
      value += text[j] ?? '';
      continue;
    }
    if (c === '\n') newlines++;
    value += c;
  }
  return { value, newlines, end: text.length, open: false };
}

function lineEnd(text, from) {
  const nl = text.indexOf('\n', from);
  return nl < 0 ? text.length : nl;
}

function blockCommentEnd(text, from) {
  const close = text.indexOf('*/', from + 2);
  return close < 0 ? text.length : close + 2;
}

function countNewlines(text, from, to) {
  let n = 0;
  for (let j = from; j < to; j++) if (text[j] === '\n') n++;
  return n;
}

function blankRanges(text, ranges) {
  let out = '';
  let last = 0;
  for (const [start, end] of ranges) {
    out += text.slice(last, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
    last = end;
  }
  return out + text.slice(last);
}

// Repo-relative forward-slash path; null for paths outside the root or inside skipped directories.
function cleanPath(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const rel = path.posix.normalize(file.replaceAll('\\', '/'));
  if (rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return null;
  return rel.split('/').some((part) => SKIP_DIRS.includes(part)) ? null : rel;
}

function isFile(abs, followLinks = false) {
  try { return (followLinks ? fs.statSync(abs) : fs.lstatSync(abs)).isFile(); } catch { return false; }
}

function globList(value) {
  return [value].flat().filter((g) => typeof g === 'string' && g.trim());
}

function matcher(globs) {
  const res = globs.map((g) => globToRegExp(g));
  return (p) => res.some((re) => re.test(p));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
