// Holdout evaluator for documentation: checks the candidate README against scenarios received on stdin.
import fs from 'node:fs';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const scenarios = JSON.parse(raw);
const readme = fs.readFileSync(path.join(process.env.FACTORY_CANDIDATE_DIR, 'README.md'), 'utf8');
const cases = scenarios.map((s) => ({ id: s.id, passed: s.mustInclude.every((needle) => readme.includes(needle)) }));
console.log(JSON.stringify({ cases }));
