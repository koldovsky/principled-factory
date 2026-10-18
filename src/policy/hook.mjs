#!/usr/bin/env node
// PreToolUse policy hook for Claude Code (principles 4.2, 5.1, 5.2, 5.4, 3.3).
// Pure decision logic in `decide`; when run as a program it reads the hook payload from stdin, the run policy from
// FACTORY_HOOK_POLICY, appends an execute_tool span to the run trace, and prints a deny decision when needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside, matchesAny, canonicalPath } from '../util.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const HARMLESS_TOOLS = new Set(['TodoWrite']);
const CHAINING = /&&|\|\||[;|`<>]|\$\(|\r|\n/;

export function decide(payload, policy, killswitch = { engaged: false, disabledTools: [] }) {
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  if (killswitch.engaged) return deny('the factory kill switch is engaged; stop and report');
  if ((killswitch.disabledTools ?? []).includes(tool)) return deny(`${tool} is disabled by the kill switch`);
  if (NETWORK_TOOLS.has(tool)) {
    return policy.networkAllowed ? allow() : deny('this role has no external communication; network tools are not allowed');
  }
  if (PATH_TOOLS.has(tool)) {
    const ws = policy.workspace;
    if (typeof input.pattern === 'string' && (path.isAbsolute(input.pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(input.pattern))) {
      return deny('search patterns must stay inside the workspace (no absolute paths or ..)');
    }
    const raw = input.file_path ?? input.notebook_path ?? input.path ?? null;
    const target = raw === null ? (payload.cwd ?? ws) : path.resolve(payload.cwd ?? ws, raw);
    if (!isInside(target, ws)) return deny(`path outside the workspace: ${raw}`);
    const rel = path.relative(canonicalPath(ws), canonicalPath(target)).replaceAll('\\', '/');
    if (rel && matchesAny(rel, policy.readDeny ?? [])) return deny(`${rel} is outside the data boundary for this run`);
    if (WRITE_TOOLS.has(tool) && rel && matchesAny(rel, policy.protected ?? [])) {
      return deny(`${rel} is protected (acceptance tests and factory files are owned by humans); change the product code instead`);
    }
    return allow();
  }
  if (tool === 'Bash') {
    const command = String(input.command ?? '').trim();
    if (CHAINING.test(command)) return deny('commands may not chain, pipe or redirect; run one allowed command at a time');
    const ok = (policy.bashAllow ?? []).some((prefix) => command === prefix || command.startsWith(prefix + ' '));
    return ok ? allow() : deny(`only these commands are allowed: ${(policy.bashAllow ?? []).join(' · ') || 'none'}`);
  }
  if (HARMLESS_TOOLS.has(tool)) return allow();
  return deny(`${tool} is not allowed for this role`);
}

function allow() { return { decision: 'allow' }; }
function deny(reason) { return { decision: 'deny', reason }; }

function redact(input, capture) {
  if (capture) return input;
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    out[k] = ['file_path', 'path', 'notebook_path', 'pattern', 'command'].includes(k) ? v : `<${typeof v} redacted>`;
  }
  return out;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let result;
  let policy = {};
  let payload = {};
  try {
    payload = JSON.parse(raw);
    policy = JSON.parse(fs.readFileSync(process.env.FACTORY_HOOK_POLICY, 'utf8'));
    const ks = policy.killswitch && fs.existsSync(policy.killswitch) ? JSON.parse(fs.readFileSync(policy.killswitch, 'utf8')) : undefined;
    result = decide(payload, policy, ks);
  } catch (error) {
    result = deny(`policy hook error (failing closed): ${error.message}`);
  }
  if (policy.trace) {
    const span = {
      name: `execute_tool ${payload.tool_name ?? '?'}`, kind: 'execute_tool', at: new Date().toISOString(), runId: policy.runId,
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': payload.tool_name, 'gen_ai.agent.name': policy.role,
        'factory.decision': result.decision, 'factory.reason': result.reason ?? null, 'factory.input': redact(payload.tool_input, policy.captureContent) },
    };
    try { fs.appendFileSync(policy.trace, JSON.stringify(span) + '\n'); } catch { /* tracing must not change the decision */ }
  }
  if (result.decision === 'deny') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
