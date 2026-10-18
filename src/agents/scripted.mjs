// Scripted agent for tests and demos: behaviours written in JavaScript, every action routed through the same
// policy decision as the Claude Code hook, so denials, traces and costs behave like a real run.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decide } from '../policy/hook.mjs';
import { appendJsonLine, listFiles, matchesAny, runProcess, scrubEnv, FactoryError } from '../util.mjs';

export async function runScripted(ctx) {
  const { config, role, ws, policy, killswitch, scripted } = ctx;
  const file = path.resolve(config.controlDir, config.factory.agent.script ?? 'behaviours.mjs');
  if (!fs.existsSync(file)) throw new FactoryError('AGENT', `scripted agent module not found: ${file}`);
  const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  const name = scripted?.[role] ?? scripted?.default ?? 'honest';
  const behaviour = mod.behaviours?.[role]?.[name] ?? mod.behaviours?.[role]?.default;
  if (typeof behaviour !== 'function') throw new FactoryError('AGENT', `no scripted ${role} behaviour "${name}" in ${file}`);

  const denials = [];
  const started = Date.now();
  const tool = async (toolName, input = {}) => {
    const payload = { tool_name: toolName, tool_input: input, cwd: ws, hook_event_name: 'PreToolUse' };
    const verdict = ctx.unsafeNoHook ? { decision: 'allow' } : decide(payload, policy, killswitch());
    if (policy.trace) {
      appendJsonLine(policy.trace, { name: `execute_tool ${toolName}`, kind: 'execute_tool', at: new Date().toISOString(), runId: policy.runId,
        attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': toolName, 'gen_ai.agent.name': role, 'factory.attempt': policy.attempt ?? null,
          'factory.decision': verdict.decision, 'factory.reason': verdict.reason ?? null } });
    }
    if (verdict.decision === 'deny') {
      denials.push({ tool_name: toolName, tool_input: input, reason: verdict.reason });
      return { denied: true, reason: verdict.reason };
    }
    const abs = (p) => path.resolve(ws, p);
    switch (toolName) {
      case 'Read': return { ok: true, output: fs.readFileSync(abs(input.file_path), 'utf8') };
      case 'Write':
        fs.mkdirSync(path.dirname(abs(input.file_path)), { recursive: true });
        fs.writeFileSync(abs(input.file_path), input.content);
        return { ok: true };
      case 'Edit': {
        const text = fs.readFileSync(abs(input.file_path), 'utf8');
        if (!text.includes(input.old_string)) return { ok: false, output: 'old_string not found' };
        fs.writeFileSync(abs(input.file_path), text.replace(input.old_string, input.new_string));
        return { ok: true };
      }
      case 'Glob': return { ok: true, output: listFiles(ws).filter((f) => matchesAny(f, [input.pattern])) };
      case 'Bash': {
        const [command, ...args] = String(input.command).trim().split(/\s+/);
        const res = await runProcess({ command, args, cwd: ws, env: scrubEnv(), timeoutMs: 120_000 });
        return { ok: res.status === 'completed', output: res.stdout + res.stderr };
      }
      default: return { ok: true };
    }
  };

  const out = await behaviour({ ...ctx, tool, readFile: (p) => fs.readFileSync(path.resolve(ws, p), 'utf8') });
  return {
    status: out?.stopped ? 'stopped' : 'completed', costUsd: out?.costUsd ?? 0.01, model: 'scripted', resultText: out?.text ?? '',
    usage: { input_tokens: out?.inputTokens ?? 1000, output_tokens: out?.outputTokens ?? 200 },
    denials, durationMs: Date.now() - started, sessionId: null,
  };
}
