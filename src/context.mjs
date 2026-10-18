// Context engineering (principles 2.1, 2.2, 2.4, 4.6): a short map loaded first, knowledge listed and read on demand,
// progress kept in files, and one brief per role (objective, output, tools, boundaries).
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, ensureDir } from './util.mjs';
import { allowedCommands } from './config.mjs';
import { FACTORY_DIR } from './workspace.mjs';

function firstLine(file) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^#+\s*/, '').trim();
}

export function buildMap({ config, task, plan, profile }) {
  const lines = [
    `# ${task.title}`,
    '',
    task.intent,
    '',
    '## Requirements',
    ...task.requirements.map((r) => `- ${r.id}: ${r.description}`),
    '',
    '## How your work is checked',
    `- Visible tests you can run: ${[...task.visibleTests.failToPass, ...task.visibleTests.passToPass].join(', ') || 'none'}.`,
    task.holdouts.length ? `- Hidden acceptance scenarios also run after you finish${profile.confined ? ', with your code able to read this directory but not write it' : ''}.`
      + ' You will only learn how many passed, never which.' : '',
    '- Protected files (tests, factory files) cannot be changed; edits to them are refused.',
    '',
    '## Allowed commands',
    ...allowedCommands(profile).map((c) => `- \`${c}\``),
    profile.observe ? `- To run and observe the product: ${Object.entries(profile.observe).map(([k, v]) => `${k}: \`${v}\``).join('; ')}` : '',
    profile.confined ? '- Type them exactly; only file paths may follow. They run under Node\'s permission model: code reads and writes only '
      + 'inside this directory and cannot start processes; test files share one process.' : '',
    '',
    '## Knowledge (read only what you need)',
    ...config.knowledge.map((k) => `- \`${FACTORY_DIR}/knowledge/${k}\` — ${firstLine(path.join(config.controlDir, 'knowledge', k))}`),
    '',
    '## State',
    `- Progress and feedback from earlier attempts: \`${FACTORY_DIR}/progress.md\`.`,
    plan ? `- Approved plan: \`${FACTORY_DIR}/plan.md\`.` : '',
  ].filter((l) => l !== '');
  return lines;
}

export function writeContextPack({ ws, config, task, plan, profile, progress = '' }) {
  const dir = ensureDir(path.join(ws, FACTORY_DIR));
  const map = buildMap({ config, task, plan, profile });
  const budget = config.factory.context?.mapMaxLines ?? 100;
  if (map.length > budget) {
    throw new FactoryError('CONTEXT_BUDGET', `the always-loaded map is ${map.length} lines, over the ${budget}-line budget; move detail into knowledge files`);
  }
  fs.writeFileSync(path.join(dir, 'MAP.md'), map.join('\n') + '\n');
  ensureDir(path.join(dir, 'knowledge'));
  for (const k of config.knowledge) {
    fs.copyFileSync(path.join(config.controlDir, 'knowledge', k), path.join(dir, 'knowledge', path.basename(k)));
  }
  if (plan) fs.writeFileSync(path.join(dir, 'plan.md'), plan);
  if (!fs.existsSync(path.join(dir, 'progress.md'))) fs.writeFileSync(path.join(dir, 'progress.md'), progress || '# Progress\n');
  return { mapLines: map.length };
}

export function appendProgress(ws, text) {
  fs.appendFileSync(path.join(ws, FACTORY_DIR, 'progress.md'), `\n${text.trim()}\n`);
}

// Briefs: each role gets an objective, an output format, its tools and its boundaries — nothing else.
export function brief(role, { task, attempt, feedback }) {
  const common = [
    `Start by reading ${FACTORY_DIR}/MAP.md. It is short; open knowledge files only when you need them.`,
    'Work only inside this directory. Protected files and anything outside the workspace are off limits.',
    'Your final message is not acceptance: the factory runs its own checks.',
  ];
  if (role === 'planner') {
    return [
      `Objective: research the code and write a short plan for "${task.title}" as thin vertical slices, each testable when built.`,
      'Output: a Markdown plan (research findings, design, slices with the requirement IDs they satisfy, risks) as your final message. Do not edit files.',
      'Tools: read and search only.',
      ...common,
    ].join('\n');
  }
  if (role === 'reviewer') {
    return [
      `Objective: assume the change for "${task.title}" is wrong and try to prove it. Check each requirement in ${FACTORY_DIR}/MAP.md against the diff in ${FACTORY_DIR}/review/diff.patch and the code.`,
      'Output: only JSON {"findings":[{"severity":"high|medium|low","requirement":"R1","claim":"...","file":"path","line":12}]}. Every finding must cite a real file and line. An empty list means you could not refute the change.',
      'Tools: read and search only. Do not run or edit anything.',
      ...common,
    ].join('\n');
  }
  return [
    `Objective: implement "${task.title}" so every requirement in ${FACTORY_DIR}/MAP.md holds — the rule itself, not just the visible examples.`,
    `Attempt ${attempt}.${feedback ? ` Feedback from the previous attempt is in ${FACTORY_DIR}/progress.md.` : ''}`,
    'Output: the code change; then a brief summary of what you changed and anything you could not verify.',
    'Tools: read, search, edit files, and the allowed commands only.',
    ...common,
  ].join('\n');
}
