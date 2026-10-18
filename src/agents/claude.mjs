// Claude Code adapter: headless `claude -p` with boundaries the spike verified on Windows (see BUILDLOG.md):
// dontAsk permission mode with exact allow rules, a fixed tool list, no MCP servers, no user settings or skills,
// a PreToolUse policy hook, a spend cap, and a scrubbed environment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, scrubEnv } from '../util.mjs';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'policy', 'hook.mjs');
const q = (p) => `"${p.replaceAll('\\', '/')}"`;

export function claudeSettings(policy, tools) {
  const allow = tools.filter((t) => t !== 'Bash');
  for (const prefix of policy.bashAllow ?? []) allow.push(`Bash(${prefix})`, `Bash(${prefix}:*)`);
  return {
    permissions: { allow, deny: ['WebFetch', 'WebSearch'].filter(() => !policy.networkAllowed) },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(HOOK)}` }] }] },
  };
}

export function claudeArgs({ model, budgetUsd, settingsFile, tools }) {
  return ['-p', '--output-format', 'json', '--model', model, '--max-budget-usd', budgetUsd.toFixed(4),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--settings', settingsFile, '--setting-sources', '',
    '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--tools', tools.join(',')];
}

export function parseClaudeResult(stdout) {
  let r;
  try { r = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()); } catch { return null; }
  const models = Object.entries(r.modelUsage ?? {}).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0));
  return {
    costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
    usage: r.usage ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
      cache_read_input_tokens: r.usage.cache_read_input_tokens, cache_creation_input_tokens: r.usage.cache_creation_input_tokens } : null,
    model: models[0]?.[0] ?? null,
    denials: r.permission_denials ?? [],
    resultText: r.result ?? '',
    isError: Boolean(r.is_error),
    subtype: r.subtype ?? null,
    turns: r.num_turns ?? null,
    sessionId: r.session_id ?? null,
  };
}

export async function runClaude(ctx) {
  const { ws, runDir, role, roleConfig, model, prompt, budgetUsd, timeoutMs, policy, policyFile, shouldStop, executable } = ctx;
  const settingsFile = path.join(runDir, `claude-settings-${role}.json`);
  fs.writeFileSync(settingsFile, JSON.stringify(claudeSettings(policy, roleConfig.tools), null, 2));
  const env = scrubEnv({ FACTORY_HOOK_POLICY: policyFile }, { keepPatterns: [/^ANTHROPIC_/i, /^CLAUDE_CODE_/i] });
  const res = await runProcess({
    command: executable ?? 'claude', args: claudeArgs({ model, budgetUsd, settingsFile, tools: roleConfig.tools }),
    cwd: ws, env, stdin: prompt, timeoutMs, shouldStop,
  });
  fs.writeFileSync(path.join(runDir, `agent-${role}-${ctx.attempt}.json`), JSON.stringify({ ...res, stdout: res.stdout.slice(-200_000) }, null, 2));
  const parsed = parseClaudeResult(res.stdout);
  return {
    status: res.reason === 'stopped' ? 'stopped' : res.reason === 'timeout' ? 'timeout' : parsed && !parsed.isError ? 'completed' : 'failed',
    costUsd: parsed?.costUsd ?? null, usage: parsed?.usage ?? null, model: parsed?.model ?? model,
    denials: parsed?.denials ?? [], resultText: parsed?.resultText ?? res.stderr.slice(0, 2000),
    sessionId: parsed?.sessionId ?? null, durationMs: res.durationMs, turns: parsed?.turns ?? null,
  };
}
