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

## Next

1. Vertical slice: store + resume, fixed pipeline, scripted agent, integrity / visible-test / holdout gates, three-state results,
   proof pack — on the slug example.
2. Widen group by group, committing after each.
