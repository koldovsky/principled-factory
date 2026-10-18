// Holdout evaluator: scenarios arrive on stdin (never from the workspace); results go to stdout as JSON.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const scenarios = JSON.parse(raw);
const { slug } = await import(pathToFileURL(path.join(process.env.FACTORY_CANDIDATE_DIR, 'slug.mjs')).href);
const cases = scenarios.map((s) => {
  try {
    const actual = s.omitInput ? slug() : slug(s.input);
    if (s.expectError) return { id: s.id, passed: false, expected: `throws ${s.expectError}`, actual: JSON.stringify(actual) };
    return { id: s.id, passed: actual === s.expect, expected: s.expect, actual };
  } catch (error) {
    return { id: s.id, passed: Boolean(s.expectError) && error?.name === s.expectError, expected: s.expectError ?? s.expect, actual: `throws ${error?.name}` };
  }
});
console.log(JSON.stringify({ cases }));
