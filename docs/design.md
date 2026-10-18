# Design

A small agentic software factory that implements the 35 principles in [principles.md](principles.md). Node.js 22.17+, no runtime
dependencies, Windows and Linux. Every principle maps to a mechanism in code and to tests tagged with its ID. `factory conformance`
fails if any principle has no passing test, or lacks a required `mechanism-off` test. The honest status of each principle is in
[principles.json](principles.json), and the limits that apply to all of them are in [trust.md](trust.md).

## Three places, three owners

| Place | Contents | Who may write |
|---|---|---|
| **Control** (`--control`) | factory config, AI policy, task specs, holdouts and evaluators, knowledge, maintainability rules | humans, via review; the factory only reads it |
| **Target** (`--target`) | the product repository | humans; the factory adds only a new local branch on release |
| **Store** (`--store`) | runs, hash-linked events, traces, approvals, proof packs, workspaces | the factory controller |

Builders work in a **disposable workspace**: a detached git worktree of the target at the base commit, inside the store. Holdouts
never enter it.

## A run

```
config digest approved? ─ model & tools in policy ─ kill switch ─ daily budget ─ review capacity ─ readiness ─ admission
        │ (refused with a reason and the list of problems on any failure)
        ▼
 baseline: fail-to-pass tests must fail on the base commit
        ▼
 size → plan (medium/large) ──► a human approves the plan digest ──┐
        │ small                                                   │
        ▼                                                         ▼
 context pack (.factory/) ─► builder agent ─► boundary evidence ─► gates, cheapest first ─► review (fresh process, refute)
        ▲                                         │ FAIL / NOT-EARNED and attempts left
        └──── feedback (details for visible gates, counts only for holdouts) ◄┘
                                                  │ attempts exhausted → needs-human: owner, question, default action, deadline
                                                  ▼ all PASS
 proof pack + digest ─► risk class → autonomy tier → 0, 1 or 2 human approvals citing the digest
                                                  ▼
 release: commit on a new local branch with trailers; rollback target recorded; never pushed
                                                  ▼
 incidents → change-failure rate, autonomy demotion, failure intake for improvement experiments
```

The stage graph and its allowed transitions are fixed in code (`src/store.mjs`, `src/pipeline.mjs`). Agents act only inside the
plan, build and review stages; their messages never set a status. Every stage is checkpointed, so `factory resume` continues an
interrupted or stopped run. A run whose process died needs `--recover` to take over its stale lock.

## Gates

Each gate returns `PASS`, `NOT-EARNED` (nothing was really verified: missing or empty evidence) or `FAIL`, with evidence and a
remediation hint. Any result other than `PASS` blocks acceptance. Gates run in the configured order and stop at the first
failure. A gate whose scope is empty, such as mutation testing on a docs-only change, is listed as *not applicable* in the proof
pack and never counted as a pass.

| Order | Gate | Checks | Principle |
|---|---|---|---|
| 0 | Boundary evidence | if files changed, the policy hook allowed a write or command in this attempt | 4.3, 5.2 |
| 1 | Integrity | protected files unchanged against digests taken before the agent ran | 4.2, 5.4 |
| 2 | Diff budget | a change exists and stays within the reviewable size | 8.1 |
| 3 | Maintainability | dependency rules, duplication, file size on changed files | 4.7 |
| 4 | Visible tests | the profile's test command; required tests ran and every test passed | 4.1 |
| 5 | Repeat | the same outcomes on repeated runs | 4.5 |
| 6 | Mutation | light mutants on changed lines must be killed by the tests | 4.5 |
| 7 | Holdouts | an evaluator process the builder never reaches runs hidden scenarios against the candidate it imports; the builder learns only the count | 4.2 |
| 8 | Review | a read-only reviewer in a fresh process tries to refute; findings must cite a real file and line; high-severity findings block, the rest go to the approver | 4.4 |

The gate order and options live in `factory.json`. The configuration is refused if it names an unknown gate, or a review gate
without a reviewer role, because either would skip verification silently.

## Agent adapters

| Adapter | Boundary | Cost |
|---|---|---|
| `claude` | headless `claude -p` with `--tools`, `dontAsk` mode and exact allow rules, no MCP servers, no user settings, skills or slash commands, `--max-budget-usd`, and a PreToolUse **policy hook** (`src/policy/hook.mjs`) | reported by Claude Code |
| `scripted` | deterministic behaviours for tests and the demo; every tool call goes through the same policy decision | declared by the script |
| `command` | any CLI that reads a brief on stdin. **No tool-level confinement:** the AI policy must set `allowUnconfinedAgent`, and the proof pack says so | unknown |

The policy hook confines file tools to the workspace, protects task-protected files and `.factory/`, applies data-boundary globs,
allows only exact allowlisted commands (no `&`, `|`, `;`, backticks, redirects, `$(` or line breaks), denies network tools to roles without
external communication, and denies everything while the kill switch is engaged. It fails closed on any error and writes each
decision to the trace.

The allowlisted commands run code the agent wrote, and the hook cannot see what that code does. A profile can declare
`"confine": "node-permission"`, as the Node profile does (`src/confine.mjs`): its test command, allowlist and observe commands
then run under Node's permission model, with reads and writes limited to the workspace and no child processes, workers, addons
or `node:sqlite`; test files run in the test runner's process. A command that cannot be confined is refused, the hook lets only
file paths follow a confined command, and `doctor` probes on each machine that the confinement holds. The holdout evaluator, which
imports the candidate, runs under the same model with narrower grants (`confineEvaluator`): it may read its own directory under
`control/evaluators` and the workspace, by absolute real path, and write nothing, so the candidate can neither read the hidden
scenarios from disk nor keep the inputs it is given for a later attempt. Since it cannot start processes, a confined evaluator
must import the candidate in-process. The gate keeps the evaluator's stderr as evidence, never as feedback. `doctor` does not
probe these narrower flags; the end-to-end tests do.

**Honest limit:** this is still isolation inside one OS account. Network access and other profiles are not confined, code under
test shares a process with its test report, and the candidate shares one with the holdout evaluator, so deliberately hostile code
can forge either result. [trust.md](trust.md) states the consequences and the deployment contract that removes them.

## Principle map

| # | Principle | Mechanism | Code |
|---|---|---|---|
| 1.1 | Humans own intent | a run needs a human intent approval bound to the task file's digest | `approvals`, `task` |
| 1.2 | Admit only verifiable work | acceptance cases mapped to requirements, decided non-functionals, existing protected tests; refusals recorded with reasons | `task`, `pipeline` |
| 1.3 | Research and plan, scaled | medium and large tasks run a read-only planner and stop for plan approval | `pipeline`, `context` |
| 2.1 | Repo as system of record | knowledge lives in control; the proof pack and plan are committed with the release | `context`, `delivery` |
| 2.2 | Context budget | a generated map with a line budget; knowledge listed and read on demand | `context` |
| 2.3 | State outside the context | atomic run files, hash-linked events, progress file, resume, stale-lock recovery | `store`, `pipeline` |
| 2.4 | Isolated context per step | planner, builder and reviewer as separate processes with their own briefs and tools | `agents`, `context` |
| 3.1 | Own the control flow | fixed transition table; agent output never sets status | `store`, `pipeline` |
| 3.2 | Fast feedback, cheapest first | configured gate order, stop at first failure, remediation written to progress | `pipeline`, `gates/*` |
| 3.3 | Bounded runs, escalation | attempts, spend caps, timeouts, kill switch, needs-human with owner, question, default and deadline; `sweep` | `pipeline`, `store`, `cli` |
| 4.1 | Deterministic before judgement | review runs only after every deterministic gate passed; reviewer never sees the builder's narrative | `pipeline`, `gates/review` |
| 4.2 | Protected and hidden oracle | integrity gate; hook protects files; holdouts outside the workspace, sealable, separate process, counts only; leak scan retires sets; Node profile: code under test and the candidate inside the evaluator cannot read them | `gates/deterministic`, `gates/holdout`, `holdouts`, `policy/hook`, `confine` |
| 4.3 | Evidence over assertions | three-state results; missing evidence is NOT-EARNED; boundary evidence; no silently skipped gates | `gates/result`, `gates/boundary`, `config` |
| 4.4 | Adversarial review | refute-by-default brief; findings without a real file:line are dropped; unusable output goes to a human | `gates/review`, `context` |
| 4.5 | Layered proof | baseline must fail, repeat consistency, light mutation testing | `gates/deterministic`, `gates/mutation` |
| 4.6 | Product observable to the agent | observe commands in the map and in the builder's command allowlist | `context`, `config`, `pipeline` |
| 4.7 | Maintainability target | dependency-direction, duplication and file-size sensors | `gates/maintainability` |
| 5.1 | No lethal trifecta | roles declare capabilities; a role with all three is refused | `config` |
| 5.2 | Least privilege, sandbox | worktree per run, scrubbed environment, hook confinement, exact command allowlist, no network tools; Node profile commands and the holdout evaluator under Node's permission model | `workspace`, `policy/hook`, `agents/claude`, `util`, `confine`, `gates/holdout` |
| 5.3 | Separation of duties | agents cannot approve; the requester cannot approve; two-human tiers need two people | `approvals` |
| 5.4 | Config as supply chain | the config digest needs a human approval; a mid-run change stops the run; agents cannot write factory files | `config`, `pipeline`, `policy/hook` |
| 6.1 | Standard tracing | OTel-GenAI-shaped spans for workflow, agents, tools and gates; content capture off by default | `trace`, `policy/hook` |
| 6.2 | Traceability, provenance | requirement-to-evidence table, digests and versions in the proof pack, `Assisted-by` trailer | `delivery`, `store` |
| 6.3 | Cost per accepted change | cost per role and run, failed spend counted, per accepted change | `pipeline`, `metrics` |
| 6.4 | Outcome metrics, visible | report and static dashboard lead with outcomes and stability | `metrics`, `dashboard` |
| 7.1 | Earned autonomy | change classes → tiers; the most restrictive effective tier over every class touched decides (a file counts for every class it matches, unclassified files keep the default, moves count both paths); promotion after clean releases, demotion on incidents; policy limits unattended classes | `autonomy`, `workspace` |
| 7.2 | Reversible delivery | local branch, never pushed; rollback target; incident intake | `delivery` |
| 7.3 | Fix delivery first | `doctor` checks git, clean tree, CI config, tools, confinement, deterministic tests; runs need a recent pass | `doctor` |
| 8.1 | Protect review capacity | WIP limit on waiting approvals; diff budget; «not verified» list in the proof pack | `approvals`, `gates/deterministic`, `pipeline` |
| 8.2 | Engineer comprehension | approval must cite the current proof-pack digest; plan and evidence travel with the change | `approvals`, `delivery` |
| 8.3 | AI policy, accountability | approved models and tools, unattended classes, data boundary, approver list; named approvals | `config`, `approvals` |
| 9.1 | Measured self-improvement | failure intake, registered experiments, held-out audit tasks, graders off limits, proposal only | `improve` |
| 9.2 | Entropy control | `gc` drafts small cleanup tasks from sensor findings and stale links | `gc` |
| 9.3 | Everything earns its place | gate statistics; conformance registry with mechanism-off tests | `metrics`, `conformance` |
| 9.4 | Portable core | stack profiles; agent adapters behind one interface | `profiles/`, `agents` |

## Deliberately not built

A scheduler, containers, signed attestations, canaries and production deployment. The factory stops at a reviewed local branch
and a recorded rollback target. [trust.md](trust.md) states what infrastructure must add for unattended use.
