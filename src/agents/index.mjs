// Agent adapters behind one interface (principle 9.4). The pipeline never trusts an agent's message for status.
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from './claude.mjs';
import { runScripted } from './scripted.mjs';
import { runProcess, scrubEnv, writeJsonAtomic } from '../util.mjs';

// Generic CLI agent: prompt on stdin, cost unknown unless the CLI reports it.
async function runCommand(ctx) {
  const [command, ...args] = ctx.config.factory.agent.command ?? [];
  const res = await runProcess({ command, args, cwd: ctx.ws, env: scrubEnv({ FACTORY_HOOK_POLICY: ctx.policyFile }), stdin: ctx.prompt,
    timeoutMs: ctx.timeoutMs, shouldStop: ctx.shouldStop });
  return { status: res.reason ?? (res.status === 'completed' ? 'completed' : 'failed'), costUsd: null, usage: null, model: ctx.model,
    denials: [], resultText: res.stdout.slice(-4000), durationMs: res.durationMs, sessionId: null };
}

export async function runAgent(ctx) {
  const policyFile = path.join(ctx.runDir, `policy-${ctx.role}.json`);
  writeJsonAtomic(policyFile, ctx.policy);
  const adapter = ctx.config.factory.agent.adapter;
  const run = adapter === 'claude' ? runClaude : adapter === 'scripted' ? runScripted : runCommand;
  const result = await run({ ...ctx, policyFile });
  fs.writeFileSync(path.join(ctx.runDir, `agent-${ctx.role}-${ctx.attempt}-summary.json`), JSON.stringify(result, null, 2));
  return result;
}
