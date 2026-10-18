// Positive evidence that the tool boundary was active (principles 4.3 and 5.2). Every tool call an agent makes passes
// through the policy decision, which appends an execute_tool span. Files can only change through an allowed write or
// command, so changed files with no allowed write or command in the trace mean the hook was not loaded, or was bypassed:
// the attempt has not earned acceptance, however clean it looks.
import { NOT_EARNED, PASS, gateResult } from './result.mjs';

const CHANGING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

export function boundaryEvidence({ spans, role = 'builder', attempt, changedFiles }) {
  const decided = spans.filter((s) => s.kind === 'execute_tool' && s.attributes?.['gen_ai.agent.name'] === role
    && s.attributes?.['factory.attempt'] === attempt);
  const denied = decided.filter((s) => s.attributes['factory.decision'] === 'deny').length;
  const allowedChanges = decided.filter((s) => s.attributes['factory.decision'] === 'allow' && CHANGING_TOOLS.has(s.attributes['gen_ai.tool.name'])).length;
  const evidence = { decided: decided.length, denied, allowedChanges, changedFiles };
  if (changedFiles > 0 && allowedChanges === 0) {
    return gateResult({ id: 'boundary', verdict: NOT_EARNED, evidence,
      summary: `${changedFiles} file(s) changed in attempt ${attempt}, but the policy hook allowed no write or command: nothing shows the tool boundary was active`,
      remediation: 'check that the PreToolUse policy hook is loaded for this agent before trusting its work' });
  }
  return gateResult({ id: 'boundary', verdict: PASS, evidence, summary: `${decided.length} tool call(s) decided by the policy hook, ${denied} denied` });
}
