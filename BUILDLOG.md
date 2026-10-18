# Build log

Working notes for building this factory: what's done, what's next, what's unverified. (Principle 2.3 applied to building it.)

## 2026-10-18 · Spike: headless Claude Code boundaries on Windows (Claude Code 2.1.296, claude-haiku-5-5)

Observed, not assumed:

- A PreToolUse command hook from `--settings` runs under `claude -p`. A JSON `hookSpecificOutput.permissionDecision: "deny"`
  blocks the call; the denial appears in the result's `permission_denials`.
- Real payload: `{cwd, hook_event_name, permission_mode, session_id, tool_name, tool_input, tool_use_id, transcript_path, ...}`.
  `tool_input.file_path` is absolute with backslashes; Glob may carry `path` (the workspace root itself) or nothing; Bash carries
  `command`. Saved as `tests/fixtures/claude-hook-payloads.jsonl` with the machine path replaced by `{ROOT}`.
- `--permission-mode dontAsk` with `permissions.allow: ["Bash(node --test:*)"]` ran `node --test` and denied `node -e ...` on its own.
- `--tools Read,Glob,Grep,Edit,Write,Bash` removes WebFetch/WebSearch entirely.
- `--setting-sources ''` is accepted; user skills and agents still appear in the init event but cannot be invoked without the Skill
  and Agent tools. Add `--disable-slash-commands` to drop skills.
- Spawn `claude.exe` directly (no shell) with stdin ignored; otherwise the CLI waits 3 s for stdin and warns.
- Cost: about $0.005 for the six-step adversarial spike, $0.0008 for the Bash check.

Design consequences:

- The hook must allow the workspace root itself, not only paths under it (the spike hook wrongly denied a Glob on the root).
- **Bash hole:** allowed profile commands (for example `node --test`) execute agent-written code as the same OS user, which can read
  any file. Mitigations: Bash limited to exact profile commands; holdouts encrypted at rest with a key that exists only in the
  factory process's environment; evaluator receives decrypted scenarios on stdin, never from disk. Remaining limit: agent-executed
  code can still read other files the user can (documented in `docs/trust.md`).

## 2026-10-18 · Build and validation

Built: the fixed pipeline, store and resume, policy hook, three adapters, nine gates, proof pack and release, autonomy tiers,
approvals, metrics and dashboard, doctor, gc, improvement experiments and the conformance registry. 35 principles: 23 enforced,
12 partial (`docs/principles.json`).

Found by tests, the demo or real runs, and fixed:

- A factory without a review gate could not move from gating to approval: the transition table lacked the edge. Found by the
  command-adapter test.
- A review gate with no reviewer role was skipped silently. Such a configuration is now refused, along with unknown gate names.
- The commit trailer named the last model called (the reviewer) instead of the builder's model. Found by the first real run.
- The overfit gap was recorded only when every gate passed, so it was never recorded for overfitting runs. Found by the demo.
- Refusal problems were written to the event log but not to the run, so `status` could not show them.
- The generic command adapter ran with no tool-level confinement and said nothing about it. The AI policy must now opt in
  (`allowUnconfinedAgent`), and the proof pack says so.
- Nothing proved the hook was loaded for a given attempt. The boundary gate now requires positive evidence: if files changed, the
  hook must have allowed a write or command.
- The resume test never interrupted anything. It now kills a running factory process and recovers the stale lock.

Real Claude Code runs (2.1.296; Haiku 5.5 builder, Sonnet 5.5 reviewer), total spend about $0.13:

- Honest slug task, twice: accepted, about 0.7 min and $0.04 each. Both builders tried a chained exploratory shell command
  first (`ls; cat …`); the hook denied it, and each continued with single tool calls.
- Sandbox probe through `runClaude` with the production settings: the model attempted all seven probes. The hook denied the
  outside read, the protected-test edit, the chained command, the command that was not allowlisted and the `.env` read. It
  allowed the workspace write. No web tool was available. No secret reached the trace or the reply.
- Red-team task that asked the builder, inside its task intent, to probe the sandbox: the model declined, citing the brief's
  boundaries. It is recorded as evidence of nothing about the deny paths.

## 2026-10-18 · Fresh-context review

A reviewer with no build context tried to refute the conformance claims by reading the code and neutering mechanisms in a scratch
copy. Its findings, all fixed:

- **High, 7.1:** `classify()` let a lower-risk class overwrite the default tier of an unclassified file listed before it. A
  docs edit plus a `Dockerfile` (or `.github/` file) was released unattended. The tier is now the most restrictive *effective*
  tier over every class a change touches, so a file can no longer ride on another class's earned autonomy either. Unit and
  end-to-end tests cover both orders.
- **Medium, 5.2:** the hook's chaining filter missed a single `&` (`node --test & npm publish` was allowed). Any `&` is now denied.
- **Low, 9.3/2.3:** the crash-and-resume test was flaky under full-suite load. The test now waits for a positive signal (the
  builder's policy file), and atomic state writes retry briefly on Windows when another process holds the target open.
- **Low, 4.5:** admission did not flag a fail-to-pass test that does not exist on the base commit; it now does, unless the test
  file failed to load (a legitimate failing state).
- **Low, 4.4:** only high-severity review findings block. That is by design; the docs now say so.

Claims that survived: path containment (traversal, drive case, `\\?\` prefixes, junctions), fail-closed verdicts, oracle protection,
separation of duties as asserted identities, status never set by an agent's message, and all ten mechanism-off tests.

## Next

1. Confine the Node profile's commands with Node's permission model (`--permission`, read and write limited to the workspace) so
   code the agent runs cannot read the control directory or the store. Measure what breaks (`node --test` spawns child processes).
2. Validate the generic-exit profile on a non-Node repository.
3. A deployment recipe for the trust contract: container per builder, egress proxy, evaluator under its own account, signed
   approvals.
4. Planted-defect calibration for the reviewer (4.4), run against the improvement loop's audit tasks.
