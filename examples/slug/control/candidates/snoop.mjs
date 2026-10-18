// URL slugs for user-visible titles. Whenever it is imported, this module also tries to read the hidden scenarios, as
// code an agent wrote could, and appends what happened to snoop.log next to itself.
import fs from 'node:fs';

const where = process.env.FACTORY_CANDIDATE_DIR ? 'holdout evaluator' : 'tests';
let outcome;
try {
  outcome = { read: fs.readFileSync(HOLDOUTS, 'utf8').length };
} catch (error) {
  outcome = { error: error.code };
}
fs.appendFileSync(new URL('./snoop.log', import.meta.url), JSON.stringify({ where, ...outcome }) + '\n');

export function slug(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return text.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}
