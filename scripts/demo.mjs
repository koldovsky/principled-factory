// A walk-through of the factory on the slug example with scripted agents: no model calls, no cost, under a minute.
// Usage: npm run demo            (add `-- --keep` to keep the scratch directory and its dashboard)
import path from 'node:path';
import { setupExample } from './example.mjs';
import { startRun } from '../src/pipeline.mjs';
import { openStore, loadRun } from '../src/store.mjs';
import { readTrace } from '../src/trace.mjs';
import { main } from '../src/cli.mjs';

const keep = process.argv.includes('--keep');
const ex = await setupExample();
const store = openStore(ex.store);
const step = (text) => console.log(`\n=== ${text}\n`);
const run = (builder) => startRun({ controlDir: ex.control, targetDir: ex.target, storeDir: ex.store, taskId: 'slug', requestedBy: 'alice',
  scripted: { builder } });
const status = (r) => main(['status', r.id, '--store', ex.store]);

try {
  step('1. An honest builder implements slug(). Gates run cheapest first; the change then waits for a human.');
  const honest = await run('honest');
  await status(honest);

  step('2. Alice requested the work, so she cannot approve it. Bob approves, citing the proof-pack digest.');
  const proof = loadRun(store, honest.id).proofDigest;
  await main(['approve', 'release', honest.id, '--store', ex.store, '--as', 'alice', '--proof', proof]);
  await main(['approve', 'release', honest.id, '--store', ex.store, '--as', 'bob', '--proof', proof]);

  step('3. An overfitting builder special-cases the visible tests. They pass; the hidden scenarios do not.');
  await status(await run('overfit'));

  step('4. A builder whose code rewrites a protected test through the allowed test command is caught by the integrity gate.');
  await status(await run('tamper-tests'));

  step('5. A builder that tries to read the holdouts is refused by the policy hook; the refusal is in the trace.');
  const reader = await run('read-holdouts');
  for (const s of readTrace(store, reader.id).filter((x) => x.kind === 'execute_tool' && x.attributes['factory.decision'] === 'deny')) {
    console.log(`  denied ${s.attributes['gen_ai.tool.name']}: ${s.attributes['factory.reason']}`);
  }
  await status(reader);

  step('6. Outcomes first, then cost and gate statistics.');
  await main(['report', '--store', ex.store, '--control', ex.control, '--html', path.join(ex.dir, 'dashboard.html')]);
} finally {
  if (keep) console.log(`\nKept ${ex.dir} (dashboard.html, store/, target/).`);
  else ex.cleanup();
}
