// Task specs and admission control (principles 1.1, 1.2, 1.3).
import fs from 'node:fs';
import path from 'node:path';
import { assertValid } from './schema.mjs';
import { FactoryError, hashFile, listFiles, matchesAny, readJson } from './util.mjs';
import { isApproved } from './approvals.mjs';

export const NON_FUNCTIONALS = ['security', 'accessRules', 'idempotency', 'tenancy', 'failureModes'];

const taskSchema = {
  type: 'object',
  required: ['schemaVersion', 'id', 'title', 'intent', 'requirements', 'nonFunctionals', 'visibleTests', 'holdouts', 'protected'],
  properties: {
    schemaVersion: { enum: [1] },
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    intent: { type: 'string', minLength: 1 },
    size: { enum: ['small', 'medium', 'large'] },
    changeClass: { type: 'string' },
    requirements: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'description', 'verifiedBy'],
      properties: { id: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 },
        verifiedBy: { type: 'array', minItems: 1, items: { type: 'string' } } } } },
    nonFunctionals: { type: 'object', required: NON_FUNCTIONALS,
      additionalProperties: { type: 'string', minLength: 1 } },
    visibleTests: { type: 'object', required: ['failToPass', 'passToPass'],
      properties: { failToPass: { type: 'array', items: { type: 'string' } }, passToPass: { type: 'array', items: { type: 'string' } } } },
    holdouts: { type: 'array', items: { type: 'string' } },
    protected: { type: 'array', minItems: 1, items: { type: 'string' } },
    context: { type: 'array', items: { type: 'string' } },
  },
};

export function loadTask(controlDir, taskId) {
  const file = path.join(controlDir, 'tasks', `${taskId}.json`);
  if (!fs.existsSync(file)) throw new FactoryError('NO_TASK', `no task ${taskId} in ${path.join(controlDir, 'tasks')}`);
  return { task: readJson(file), digest: hashFile(file), file };
}

export function sizeOf(task) {
  if (task.size) return task.size;
  const n = task.requirements.length;
  return n <= 2 ? 'small' : n <= 5 ? 'medium' : 'large';
}

// Only work the factory can verify gets in. Returns a list of reasons; empty means admissible.
export function admissionProblems({ task, digest, controlDir, targetDir, store, holdoutIds }) {
  const problems = [];
  try { assertValid(task, taskSchema, `task ${task.id ?? '?'}`); } catch (error) { return error.errors.map((e) => `schema ${e}`); }
  const visible = new Set([...task.visibleTests.failToPass, ...task.visibleTests.passToPass]);
  if (!task.visibleTests.failToPass.length && !task.holdouts.length) {
    problems.push('no acceptance case proves the change: list fail-to-pass visible tests or holdout sets');
  }
  for (const req of task.requirements) {
    for (const ref of req.verifiedBy) {
      const [kind, name] = ref.split(':');
      if (kind === 'visible' && !visible.has(name)) problems.push(`${req.id} cites visible test "${name}", which visibleTests does not list`);
      else if (kind === 'holdout' && !task.holdouts.includes(name)) problems.push(`${req.id} cites holdout set "${name}", which the task does not use`);
      else if (!['visible', 'holdout'].includes(kind)) problems.push(`${req.id}: verifiedBy entry "${ref}" must be visible:<test> or holdout:<set>`);
    }
  }
  for (const set of task.holdouts) if (!holdoutIds.includes(set)) problems.push(`holdout set ${set} not found in control/holdouts`);
  for (const key of NON_FUNCTIONALS) {
    if (/^\s*(tbd|todo|\?)\s*$/i.test(task.nonFunctionals[key] ?? '')) problems.push(`non-functional "${key}" is still undecided`);
  }
  const protectedFiles = listFiles(targetDir).filter((f) => matchesAny(f, task.protected));
  if (!protectedFiles.length) problems.push('protected globs match no file in the target: the acceptance tests would be editable');
  if (!isApproved(store, 'intent', task.id, digest)) {
    problems.push(`intent not approved: a human must approve task ${task.id} at digest ${digest.slice(0, 12)}… (factory approve intent ${task.id} --as <name>)`);
  }
  return problems;
}
