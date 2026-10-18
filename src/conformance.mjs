// Conformance (principle 9.3): every principle in docs/principles.json must have passing tests tagged with its ID,
// boundary principles must also have a «mechanism-off» test proving the test depends on the mechanism,
// and no tagged test may fail. Statuses (enforced / partial / documented) are declared honestly in the registry.
import path from 'node:path';
import { FACTORY_ROOT } from './config.mjs';
import { parseTap } from './gates/deterministic.mjs';
import { listFiles, readJson, runProcess } from './util.mjs';

export function tagsOf(name) {
  return { principles: [...name.matchAll(/\[P(\d+\.\d+)\]/g)].map((m) => m[1]), mechanismOff: /\[mechanism-off\]/.test(name) };
}

export function evaluate(registry, tests) {
  const rows = registry.principles.map((p) => {
    const tagged = tests.filter((t) => tagsOf(t.name).principles.includes(p.id) && !t.skipped);
    const passing = tagged.filter((t) => t.ok).length;
    const failing = tagged.filter((t) => !t.ok).map((t) => t.name);
    const mechanismOff = tagged.filter((t) => t.ok && tagsOf(t.name).mechanismOff).length;
    const problems = [];
    if (!passing) problems.push('no passing test');
    if (failing.length) problems.push(`${failing.length} failing test(s)`);
    if (p.requiresMechanismOff && !mechanismOff) problems.push('no mechanism-off test');
    return { ...p, passing, failing, mechanismOff, ok: !problems.length, problems };
  });
  return { rows, ok: rows.every((r) => r.ok) };
}

export async function conformance({ root = FACTORY_ROOT } = {}) {
  const registry = readJson(path.join(root, 'docs', 'principles.json'));
  const files = listFiles(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('tests', f));
  const res = await runProcess({ command: 'node', args: ['--test', '--test-reporter=tap', ...files], cwd: root, env: process.env, timeoutMs: 900_000 });
  const tests = parseTap(res.stdout).filter((t) => t.depth === 0 || /\[P\d/.test(t.name));
  return { ...evaluate(registry, tests), testsRun: tests.length, exitCode: res.exitCode };
}

export function formatConformance(result) {
  const lines = ['Principle                                         Status       Tests  Off  Result', '─'.repeat(84)];
  for (const r of result.rows) {
    lines.push(`${`${r.id} ${r.name}`.slice(0, 48).padEnd(49)} ${r.status.padEnd(12)} ${String(r.passing).padStart(5)} ${String(r.mechanismOff).padStart(4)}  ${r.ok ? 'ok' : `PROBLEM: ${r.problems.join('; ')}`}`);
  }
  const counts = result.rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  lines.push('─'.repeat(84), `${result.rows.length} principles · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')} · ${result.testsRun} tests run · ${result.ok ? 'CONFORMS' : 'DOES NOT CONFORM'}`);
  return lines.join('\n');
}
