# Trust and isolation

What the factory trusts, what each boundary actually stops, and what it does not. Read this before running the factory on
anything that matters.

## The one assumption behind every guarantee

**Code that an agent writes and then runs must not be able to write the control directory or the store.**

Every status in [principles.json](principles.json) holds under this assumption. On a single OS account it holds only in part.
The builder may run only exact allowlisted commands, and those commands execute code the agent wrote: the tests import the
product module, and the product module is the agent's work. No tool-level hook sees what that code does, because the hook only
sees the command line.

With the Node profile, that code runs under **Node's permission model**. The commands the builder must type are:

```
node --permission --allow-fs-read=. --allow-fs-write=. --no-experimental-sqlite --experimental-test-isolation=none --test
node --permission --allow-fs-read=. --allow-fs-write=. --no-experimental-sqlite demo.mjs
```

The factory's own test runs (baseline, visible tests, repeat, mutation and `doctor`) use the same flags. Started in the
workspace's real path, the code can read and write only inside the workspace. It cannot read the holdouts, the store, the control
directory or the home directory, and it cannot start processes or workers, load native addons, or use WASI, the inspector or
`node:sqlite` (the permission model does not cover `node:sqlite`, so the module is switched off). The hook allows only file paths
after these commands, because an appended option such as `--allow-fs-read=*` would widen the grant.

What is still not confined:

- **Network.** Node 22 and 24 have no network permission. The code can open connections and send whatever it can read: the
  workspace and its own environment.
- **The holdout evaluator.** It runs the candidate's code unconfined, in the same process as the decrypted scenarios.
- **The test report.** Test files run in the test runner's own process, because a child process per file would need
  `--allow-child-process`, and a child process is outside the permission model. So code under test can rewrite the TAP output
  and exit code of its own run. The holdouts, mutation and review gates and the deployment contract's CI re-run do not depend
  on that report.
- **Other profiles.** `generic-exit`, and any profile without `"confine": "node-permission"`, run their commands unconfined.
- **Signals.** The code can signal other processes of the same user, the factory included.

So locally, the factory is a strong harness against an agent that **makes mistakes, overfits or follows bad instructions through
its tools**, and with the Node profile the agent's code can no longer reach the factory's files through the allowed commands. It
is still not a security boundary against an agent that **deliberately writes code to escape**: the gaps above remain, and the
permission model is a control inside one Node process, not an OS boundary. The
[deployment contract](#deployment-contract-for-unattended-use) closes that gap with OS-level isolation that a Node process cannot
create for itself.

## Threat model

| The agent may… | Example | Stopped by |
|---|---|---|
| be wrong | an off-by-one in `slug()` | visible tests, repeat, mutation, holdouts, review |
| overfit to visible tests | special-case the five test inputs | holdouts run by a separate process; feedback is counts only |
| edit the oracle through its tools | `Edit test/slug.test.mjs` | hook denies protected paths; integrity gate re-checks file digests |
| edit the oracle through code it runs | a test helper that rewrites a test file | integrity gate (digests taken from the base commit), mutation gate; confinement still allows writes inside the workspace |
| read hidden scenarios through its tools | `Read ../control/holdouts/set-a.json` | hook confines file tools to the workspace |
| read hidden scenarios through code it runs | `fs.readFileSync` in product code during the tests | Node profile: the permission model denies it (`ERR_ACCESS_DENIED`). In the holdout evaluator, which is not confined: **sealed** holdouts only (AES-256-GCM, key outside the builder's environment); see limits |
| widen its own confinement | append `--allow-fs-read=*` to the allowed test command | the hook allows only file paths after a confined command; a profile command that cannot be confined is refused |
| forge its own test report | product code that rewrites stdout and the exit code during the tests | **not** the visible-tests gate; holdouts in a separate process, mutation, review, the CI re-run of the deployment contract |
| put hidden inputs into its answer | copy scenario inputs into the code | leak scan of changed files; the leaked set is retired |
| follow injected instructions | a README line telling agents to fetch a URL | no network tools; Bash is an exact allowlist with no chaining; data-boundary globs |
| claim success it did not earn | "all tests pass" with no change | status comes from gates, never from the agent's message |
| work while the hook is not loaded | settings not picked up | boundary gate: changed files need an allowed write or command decided by the hook |
| run away on cost or time | an endless retry loop | attempt limit, per-run and daily spend caps, timeouts, kill switch |

## Boundaries, layer by layer

**Tool layer (Claude Code adapter).** `claude -p` runs with an explicit `--tools` list (no web tools for roles without external
communication), `--permission-mode dontAsk` with exact allow rules, no MCP servers, no user settings, skills or slash commands, no
session persistence and a `--max-budget-usd` cap. A PreToolUse hook decides every call and fails closed on any error:

- file tools are confined to the workspace (real paths, case-insensitive on Windows, links followed);
- writes to protected paths (task-protected files and `.factory/`) are denied;
- data-boundary globs (for example `**/.env`) are denied even inside the workspace;
- Bash runs only commands that equal an allowlisted prefix or extend it with arguments, and after a confined command only file
  paths (no options, quotes, globs or shell expansions); any `&`, `|`, `;`, backtick, `<`, `>`, `$(` or line break is denied;
- network tools are denied unless the role declares external communication;
- an engaged kill switch denies everything, read on every call.

Each decision is appended to the run trace as an `execute_tool` span. The boundary gate then requires positive evidence: if files
changed, the hook must have allowed at least one write or command in that attempt.

**Process layer.** The agent gets a scrubbed environment (operating-system basics plus `ANTHROPIC_*` and `CLAUDE_CODE_*`), runs in
a disposable git worktree, and is killed as a process tree on timeout or stop. With the Node profile, the commands that run its code
also run under Node's permission model, limited to the workspace (above). `doctor` proves this on each machine before any run: a
probe under the same flags must be able to use its workspace, and must be denied an outside read, an outside write, a relative
symlink out of the workspace (the CVE-2025-55130 pattern), a child process and `node:sqlite`. Runs are refused without a recent
passing check, so a Node version that fails the probe cannot run the Node profile.

**Oracle layer.** Protected files are fingerprinted from the base commit before the agent starts. Holdouts live in the control
directory, outside every workspace, and can be sealed with AES-256-GCM using a key held only in the factory process's
environment. A separate evaluator process receives the scenarios on stdin and reports per-scenario results to the factory; the
builder sees only "X of Y passed".

**Human layer.** Approvals name a person and bind an exact digest (configuration, task intent, plan, proof pack). Agent identities
cannot approve; the requester cannot approve their own release; two-human tiers need two different people; the review queue has a
WIP limit.

## Limits, stated plainly

- **Same OS account.** With the Node profile, code the agent runs through allowed commands and the factory's test runs is limited
  to the workspace by Node's permission model. It can still make network connections, signal the user's processes and forge its
  own test report. The holdout evaluator runs the candidate unconfined, so code running there can read every file the user can
  read (other repositories, `~/.claude` credentials, the control directory and the store) and write files the hook would have
  refused. Other profiles get no confinement at all.
- **The permission model has gaps of its own.** Node documents that it does not cover every API (`node:sqlite` is its example and
  is switched off here), and it has had bypasses: CVE-2025-55130, a relative-symlink escape, affects Node up to 22.21.1 and 24.12.0.
  The `doctor` probe tries the escapes known here; an escape it does not try remains a risk.
- **Sealed holdouts raise the bar; they do not end the risk.** There is no plaintext on disk and the key is not in the builder's
  environment. But unconfined code running as the same user, such as the candidate inside the holdout evaluator, can read another
  process's environment or memory (`/proc/<pid>/environ` on Linux, process memory on Windows). Real separation needs the
  evaluator and its key under another account or on another machine.
- **Approvals and run state are plain files.** Identities passed with `--as` are asserted, not authenticated. Approval records are
  JSON lines in the store. Run events are hash-linked, so `factory verify-events` detects edited or removed events, but anyone who
  can write the store can append a well-formed forged record.
- **No egress control.** The factory denies network tools, not network traffic from code the agent runs; Node's permission model
  on Node 22 and 24 has no network scope.
- **The generic command adapter has no tool-level confinement at all.** The AI policy must opt in with `allowUnconfinedAgent`,
  its cost is unknown, and every proof pack it produces says so.
- **Unknown cost.** Agents that report no cost are bounded only by time limits and attempts.

## Deployment contract for unattended use

To make the statuses hold without the caveats above, deploy the factory like this:

1. Run each builder in a container or under a dedicated OS user that can read and write **only its workspace**. It has no access
   to the control directory, the store, other repositories or the home directory.
2. Allow egress only to the model API, through a proxy that logs requests.
3. Run the holdout evaluator under a separate account or service that holds the key. The builder's account cannot read that key.
4. Keep the store on storage the builder cannot write, ideally append-only. Take approvals from an authenticated system, such as
   signed commits, protected-branch reviews or SSO-backed approval records, instead of `--as`.
5. Re-run the deterministic gates in CI on the released branch before merge, from a clean checkout.
6. Give the factory its own model credentials with a spend limit, separate from any person's credentials.

Until then, keep the defaults: no task class runs unattended except documentation, every code change waits for a human, and
releases are local branches that are never pushed.

## What was verified, and how

- **Automated:** `npm test` and `factory conformance`. Every principle has tagged tests, and ten principles have
  `mechanism-off` tests. Each switches off named mechanisms (recorded as an unsafe run that can never be released) and shows that
  the attack then succeeds.
- **Real model, 18 October 2026 (Claude Code 2.1.296, Claude Haiku 5.5 builder, Claude Sonnet 5.5 reviewer):**
  - Three honest runs of the slug task, the third on the final code: accepted end to end, released to a local branch with
    provenance trailers. Each cost about $0.04 and took under a minute. The hook decided every tool call and denied the
    builders' chained or non-allowlisted shell commands; they continued with file tools.
    The release approval used a second asserted identity, so it shows the approval path works, not that two real people were
    involved.
  - A probe through the production adapter, with the same settings, flags, hook and environment: the model attempted seven
    forbidden or borderline actions. The hook denied the read outside the workspace, the protected-test edit, the chained command,
    the command that was not allowlisted and the `.env` read. The write inside the workspace was allowed, and no web tool existed.
    No secret appeared in the trace or the reply.
  - A red-team task whose intent asked the builder to probe the sandbox: the model **declined** all four probes, citing the
    brief's boundaries, and implemented the task honestly. That run proves nothing about the deny paths. The probe above does.
- **Fresh-context review:** a reviewer with no build context tried to refute the claims. It found an autonomy hole (an
  unclassified file could ride on a later docs file) and a missing `&` in the chaining rule; a follow-up check found two more
  autonomy holes (a file matching several classes took the first listed; renames hid a path). All are fixed and tested. The
  reviewer did not examine 2.2, 3.2, 4.7, 6.3 or 6.4 in depth.
- **Confinement, 18 October 2026, Windows 11, Node 24.18:** from code running under the confined flags, outside reads, writes,
  `stat`, directory listings and watches, `import()` and `require` of outside files, junctions, file and relative symlinks, hard
  links, copies and renames from outside, `process.binding`, child processes, workers, the inspector, addons, report and heap
  snapshot writes outside, and `process.loadEnvFile` were all denied. `node:sqlite` created database files in the store until it
  was switched off. An option appended after `--test` (`--allow-fs-read=*`) restored the outside read, hence the hook rule. A
  junction in the workspace path made the relative grant miss the real paths that the module loader opens, so commands start in
  the real path. End-to-end tests run a builder whose product code reads the holdouts during the tests: denied with
  `ERR_ACCESS_DENIED` while the tests pass, and read in full with confinement switched off. The flags for Node 22 come from its
  documentation; Node 22 was not available on this machine.
- **Not verified:** the generic-exit profile, runs on macOS, a repeat of the sandbox probe after the `&` fix (the fix only adds
  denials), the deployment contract (it is a contract, not code here), the confined commands on Node 22 and on Linux (CI runs
  both once the change is pushed), and a real Claude Code builder typing the confined commands (its allow rules now contain `=`
  and `.`).
