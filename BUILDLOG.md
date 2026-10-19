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

Real Claude Code runs (2.1.296; Haiku 5.5 builder, Sonnet 5.5 reviewer), total spend about $0.17 including the third honest
run on the final code (after the review fixes below):

- Honest slug task, three times: accepted, about 0.7 min and $0.04 each. Both builders tried a chained exploratory shell command
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

A follow-up check of the same family found two more 7.1 holes, both fixed and tested end to end:

- A file that matched several classes took the first one listed: `docs/helper.mjs` was docs (auto), and
  `migrations/notes.md` was docs instead of a two-person migration. A file now counts for every class it matches.
- `git diff` detected renames, so a move arrived as one `old => new` string that globs matched unpredictably. Diffs now use
  `--no-renames -z`: a move is a delete plus an add, and both paths are classified.

Claims that survived: path containment (traversal, drive case, `\\?\` prefixes, junctions), fail-closed verdicts, oracle protection,
separation of duties as asserted identities, status never set by an agent's message, and all ten mechanism-off tests.

## 2026-10-18 · Confinement with Node's permission model (Windows 11, Node 24.18)

Observed, not assumed (Node 22 was not available on this machine; its flag names come from the Node 22 docs):

- `node --permission --allow-fs-read=<ws> --allow-fs-write=<ws> --test` fails at once: the runner spawns a child per test file,
  and the permission model denies child processes. With `--allow-child-process`, Node 24.18 handed the children
  `--allow-fs-read=` without its value (they exited with code 9), and any child process is outside the model anyway.
- With test isolation `none` the tests run in the runner's process and stay confined: product code reading the control
  directory's holdouts got `ERR_ACCESS_DENIED`, and the TAP output keeps its shape (a test file that fails to load is still
  reported under its file name). Node 23.6 renamed the flag to `--test-isolation`; Node 22 only knows
  `--experimental-test-isolation`, which Node 24 still accepts, so the factory uses that name.
- Relative grants (`--allow-fs-read=.`) resolve against the start directory. A junction in that path broke them: the module
  loader opens real paths, so test files failed to load with `ERR_ACCESS_DENIED`. Workspaces are now recorded by their real path,
  and test runs start there.
- Denied from inside: outside reads, writes, `stat`, listings and watches; `import()` and `require` of outside files;
  junctions, file and relative symlinks; hard links; copies and renames from outside; `chdir` tricks; Buffer, URL, `\\?\`, UNC and
  case variants; `process.binding`; child processes; workers; the inspector; addons; report and heap-snapshot writes outside;
  `process.loadEnvFile`. Not restricted: network, signals to other processes (the parent included), the environment.
- **`node:sqlite` bypasses the model.** Confined code created database files in the store. `--no-experimental-sqlite` removes
  the module; the Node docs name `node:sqlite` as outside the model.
- **An option appended to an allowlisted command widens the grant.** `... --test --allow-fs-read=*` read the holdouts again.
  Quotes, globs, braces, `$VAR` and backslashes can smuggle options through bash, so the hook now accepts only plain file paths
  after a confined command. An option written after the first file path is itself treated as a file pattern. A profile command
  with `--env-file` would do the same from inside the workspace: `NODE_OPTIONS=--allow-fs-read=*` in the env file restored the
  read.
- **In-process tests share the reporter's process.** Product code that rewrote stdout and reset the exit code turned a failing
  run into "2 pass, 0 fail". Under process isolation the same code corrupted the child's report stream, and the run reported only
  the file name, as passing. So deliberately hostile code could forge the visible-test report before this change too; the holdout,
  mutation and review gates do not rely on it.

Built:

- `src/confine.mjs`. A profile with `"confine": "node-permission"` (the Node profile) gets every command confined: the test
  command, the allowlist and the observe commands. A command that cannot be confined (not `node`, or one carrying `--allow-*`,
  `--experimental-sqlite`, a test-isolation flag, `--env-file` or a config-file flag) makes the configuration fail to load.
- The map lists the commands the builder may type, which are the confined ones, with a line on what confinement means.
- `doctor` runs a probe under the same flags: it must be able to use its workspace, and an outside read, an outside write, a
  CVE-2025-55130-style relative symlink, a child process and `node:sqlite` must all be denied. Runs refuse without a passing check,
  so a Node version that fails the probe cannot run the Node profile.
- Unsafe test switch `confinement`: the run uses the plain commands; it is recorded and can never be released.
- Tests: a builder whose product code reads the holdouts whenever it is imported. Confined, every test-run read gets
  `ERR_ACCESS_DENIED` and the visible tests pass; with `confinement` switched off, the same code reads the holdouts in full. Its
  log also shows the holdout evaluator reading them, because the evaluator still runs the candidate unconfined.

Not done, and stated in docs/trust.md: the holdout evaluator, network egress, the test report's integrity and other profiles.
`npm test` (146 tests) and `factory conformance` pass on Windows with Node 24.18. Node 22 and Linux are not verified yet. A real
Claude Code builder typing the confined test command is verified in the next section.

## 2026-10-18 · A real builder on the confined commands (Claude Code 2.1.296; Haiku 5.5 builder, Sonnet 5.5 reviewer)

One honest slug run on commit 4ad21e8, set up as the earlier real runs were: the slug example with the `claude` adapter, and a
passing `doctor`, confinement check included. The run took 39 seconds and cost $0.0399 (builder $0.0049, reviewer $0.0350).
Observed in the run's trace and the builder's Claude Code result:

- The builder read `.factory/MAP.md` and tried a chained `ls -la; ls -la .factory; cat slug.mjs …` first, which the hook denied,
  as in all four earlier real builder runs. It continued with file tools and wrote `slug.mjs`. Then it typed the confined test
  command from the map with a file path appended: `node --permission --allow-fs-read=. --allow-fs-write=. --no-experimental-sqlite
  --experimental-test-isolation=none --test test/slug.test.mjs`. The hook allowed it, because a file path is an operand. The
  earlier builders had all typed `node --test --test-reporter=tap`; after a confined command the hook would deny that option, and
  this builder did not add it.
- Claude Code did not deny it: `permission_denials` held only the chained command that the hook had denied. With a path
  appended, only the `Bash(<confined command>:*)` rule can match, so the dontAsk layer of Claude Code 2.1.296 matches a prefix rule
  that contains `=` and `.`. The way the rules are written needed no fix.
- The run was accepted: all nine checks passed, with mutation at 4/6 and holdouts at 8/8. It was released to a local branch on a
  second asserted identity's approval, and the commit carries `Assisted-by: claude-haiku-5-5`.

What this run does not show:

- The command's output. `--output-format json` with `--no-session-persistence` keeps no tool results. "All 5 visible tests
  pass" is the builder's own report; the gates ran the tests themselves.
- The bare command with nothing appended, which the exact rule `Bash(<confined command>)` covers.
- The confined `demo.mjs` command, which the builder did not run.

Total real-model spend is now about $0.21.

## 2026-10-18 · Confining the holdout evaluator (Windows 11, Node 24.18)

Observed, not assumed (Node 22's flag semantics come from its docs: one `--allow-fs-read` per path, a directory grants what is
below it, entry points are readable without a grant since 22.17):

- The slug evaluator ran under `node --permission --allow-fs-read=<its directory> --allow-fs-read=<workspace>
  --no-experimental-sqlite`, started in an empty scratch directory, and reported all eight scenarios. A candidate imported by it
  was denied reading the holdouts, a listing of the control directory, the home directory and the scratch directory, and writing
  the workspace, the scratch directory, the run directory and the temp directory. A junction, a child process and a worker were
  denied, and `node:sqlite` was absent. `fs.realpath` of an outside path still answered (path information only). No descriptor
  beyond stdin, stdout and stderr was open; that matters because the model does not check descriptors that are already open.
- The evaluator also loaded with no grant for its own file (Node 24 reads entry points implicitly); its directory is granted
  anyway, so evaluators can import helpers. A `.js` evaluator in a control directory without `package.json` ran too.
- **The candidate still shares the evaluator's process.** A wrong `slug()` that patched `console.log` made the confined evaluator
  report 8 of 8 passed. Confinement stops it reading and writing files, not rewriting the report. The threat model had credited
  the holdouts, and the CI re-run of the deployment contract, against a forged test report; both run the same code, so the
  forging code can rewrite their results too. The table now says so, and the deployment contract asks for the candidate in a
  process of its own.
- Unconfined, the same candidate read the scenarios in full, wrote in the workspace (which the next attempt starts from) and
  kept every input it was given in the run directory.

Built:

- `confineEvaluator` in `src/confine.mjs`. The holdout gate uses it whenever the profile is confined, so the unsafe switch
  `confinement` turns it off along with the rest. The workspace, the evaluator and the scratch directory are used by real path.
  The evaluator must be a file under `control/evaluators`, judged by its real path, or the set is NOT-EARNED: its directory is
  granted to the candidate, so it must never be the control directory or the holdouts. A first version checked the path as
  written, which a file symlink in `evaluators/` would have passed while the grant followed the link to the control directory.
- The gate keeps the evaluator's stderr (its first 2,000 characters) as evidence whatever the verdict, so a denial inside the
  evaluator is visible to people. It never reaches the builder, whose feedback stays counts only.
- The map tells the builder that hidden scenarios run its code with read access to the workspace and no writes, so an honest
  product that writes files is not left guessing why every hidden scenario fails.
- The snooping candidate reports on stderr where it may not write its log, and inside the evaluator tries to keep each input
  it is given in the run directory, outside the workspace.
- Tests: confined, the candidate's read inside the evaluator gets `ERR_ACCESS_DENIED`, as do its log write in the workspace and
  every write outside it, and the honest slug passes the holdouts; with `confinement` switched off, it reads the scenarios in full
  and keeps the inputs. Unit tests pin the evaluator's flags and refuse an evaluator outside `control/evaluators`, also one
  linked in from outside. That last test needs file symlinks, which this Windows account cannot create, so it skips here; a
  simulation that made `realpath` follow such a link was refused by the new check and let through by the first version.

Not done, and stated in docs/trust.md: network egress, the reports of the processes the agent's code runs in (its test report
and the evaluator's result), other profiles, and a `doctor` probe of the evaluator's flags (the end-to-end tests cover them).
`npm test` (151 tests, the symlink test skipped) and `factory conformance` pass on Windows with Node 24.18. Node 22 and Linux
are not verified yet.

## 2026-10-19 · CI on the confinement

With both confinement branches merged (`9c7e87c`), CI passed on Ubuntu and Windows with Node 22 and 24: 151 of 151 tests in each
job, none skipped. The confinement and evaluator tests, their mechanism-off counterparts and the symlink test that this Windows
account skips all ran. This supersedes the «Node 22 and Linux are not verified yet» notes above.

## Next

1. Run the candidate in a process of its own, driven by the evaluator over a pipe, so that hostile code cannot rewrite the
   holdout result.
2. Validate the generic-exit profile on a non-Node repository.
3. A deployment recipe for the trust contract: container per builder, egress proxy, evaluator under its own account, signed
   approvals.
4. Planted-defect calibration for the reviewer (4.4), run against the improvement loop's audit tasks.
