# Design

A small agentic software factory that implements the 35 principles in [principles.md](principles.md). Node.js 22+, no runtime
dependencies, Windows and Linux. Every principle maps to a mechanism in code and at least one test tagged with its ID; `factory
conformance` fails if any principle has no passing test.

## Three places, three owners

| Place | Contents | Who may write |
|---|---|---|
| **Control** (`--control`) | factory config, AI policy, task specs, holdouts, knowledge (skills), maintainability rules | humans, via review; the factory only reads it |
| **Target** (`--target`) | the product repository | humans; the factory writes only a new branch on release |
| **Store** (`--store`) | runs, events, evidence, traces, approvals, metrics | the factory controller |

Builders work in a **disposable workspace** inside the store: a fresh copy of the target per run. Holdouts never enter it.

## A run

```
config digest approved? ─ policy & trifecta ─ admission ─ review capacity ─ readiness
        │ (refuse with a reason on any failure)
        ▼
 size → plan (medium/large) ──► human approves plan ──┐   (pausable step, resumable)
        │ small                                       │
        ▼                                             ▼
 workspace + context pack ─► builder agent ─► gates (cheapest first) ─► holdouts (separate process, count only)
        ▲                                         │ FAIL / NOT-EARNED, attempts left
        └──────────── feedback (details for visible gates, counts for holdouts) ◄┘
                                                  │ attempts exhausted → needs-human (escalation contract)
                                                  ▼ all PASS
 adversarial review ─► proof pack + provenance ─► risk class → autonomy tier → 0/1/2 human approvals
                                                  ▼
                       release: patch on a new branch, rollback target recorded, never pushed
                                                  ▼
                       incident intake → metrics, autonomy demotion, failure intake for improvement
```

The graph is fixed in `src/pipeline.mjs`. Agents act only inside the plan, build and review steps; their messages never set a status.

## Gates

Each gate returns `PASS`, `NOT-EARNED` (nothing was really verified: missing or empty evidence) or `FAIL`, with evidence and a
remediation hint. Cheap gates run first; a failing cheap gate skips the expensive ones.

| Order | Gate | Principle |
|---|---|---|
| 1 | Integrity — protected files (tests, specs, `.factory/`) unchanged | 4.2, 5.4 |
| 2 | Diff budget — changed lines within the slice limit | 8.1 |
| 3 | Maintainability — dependency direction, duplication, file size | 4.7 |
| 4 | Profile checks — lint/build/visible tests from the stack profile | 3.2, 4.1 |
| 5 | Repeat — visible tests k times, all identical | 4.5 |
| 6 | Mutation — light mutants on changed lines must be killed | 4.5 |
| 7 | Holdouts — separate process, aggregate-only result | 4.2 |
| 8 | Review — fresh-context reviewer, refute by default, evidence-bound findings | 4.4 |

At admission the visible tests must fail on the original target (they prove the change) — principle 4.5.

## Boundaries enforced on the builder (Claude Code adapter)

Headless `claude -p` with: `--permission-mode dontAsk`, an explicit tool list, `--strict-mcp-config` with no servers, a spend cap
(`--max-budget-usd`), and generated settings whose **PreToolUse hook** denies:

- file access outside the workspace (covers holdouts, control, store, other clients' data);
- writes to protected paths (tests, specs, `.factory/`);
- network tools and network commands for roles without external communication;
- destructive commands (`git push`, `rm -rf` outside the workspace, history rewrites);
- everything, when the kill switch is engaged (the hook reads it on every call).

Each hook decision is appended to the run trace as an `execute_tool` span.

**Honest limit:** this is policy-level isolation in the same OS account. OS-level isolation (containers, separate users, network
allowlists) is a deployment contract, documented in [trust.md](trust.md) — not something a local Node process can create.

## Principle map

| # | Principle | Mechanism | Module |
|---|---|---|---|
| 1.1 | Humans own intent | task intent must carry a human approval bound to the task digest | `approvals`, `task` |
| 1.2 | Admit only verifiable work | schema requires acceptance cases + non-functionals; refusal is recorded | `task` |
| 1.3 | Research and plan, scaled | size class → planner role + plan approval for medium/large | `pipeline`, `roles` |
| 2.1 | Repo as system of record | plan, decisions and proof pack committed with the release; knowledge lives in control | `delivery`, `context` |
| 2.2 | Context budget | generated map with a line budget; knowledge listed, loaded on demand | `context` |
| 2.3 | State outside the context | atomic stage checkpoints, progress file, `resume` | `store`, `pipeline` |
| 2.4 | Isolated context per step | separate processes per role, each with a brief (objective, output, tools, boundaries) | `roles` |
| 3.1 | Own the control flow | fixed stage graph; agent output never sets status | `pipeline` |
| 3.2 | Fast feedback, cheapest first | gate order by cost, skip expensive gates on cheap failure, remediation text | `gates` |
| 3.3 | Bounded runs, escalation | attempts, wall time, spend cap, kill switch, needs-human with question and default | `pipeline`, `budget`, `killswitch` |
| 4.1 | Deterministic before judgement | review runs only after all deterministic gates pass; reviewer never sees builder narrative | `gates/review` |
| 4.2 | Protected and hidden oracle | integrity gate; holdouts outside workspace, separate process, count-only feedback, leak → retire | `gates/integrity`, `gates/holdout` |
| 4.3 | Evidence over assertions | three-state results, missing evidence = NOT-EARNED, content hashes | `gates/result`, `evidence` |
| 4.4 | Adversarial review | reviewer role, refute-by-default prompt, findings need file:line evidence, planted-defect calibration | `gates/review` |
| 4.5 | Layered proof | baseline-must-fail, repeat consistency, light mutation testing | `gates/baseline`, `gates/repeat`, `gates/mutation` |
| 4.6 | Product observable to agent | profile `observe` commands in the brief and allowed by the hook | `context`, `policy` |
| 4.7 | Maintainability target | dependency-direction rules, duplication, file-size sensors | `gates/maintainability` |
| 5.1 | No lethal trifecta | roles declare capabilities; config with all three is rejected | `policy/trifecta` |
| 5.2 | Least privilege, sandbox | disposable workspace, scrubbed env, hook confinement, network denied | `workspace`, `policy/hook` |
| 5.3 | Separation of duties | agents can't approve; approver ≠ requester; two-key tiers need two humans | `approvals` |
| 5.4 | Config as supply chain | config digest must be human-approved; agents can't write control or `.factory/` | `config`, `policy/hook` |
| 6.1 | Standard tracing | OTel-GenAI-shaped spans in JSONL, content capture off by default | `trace` |
| 6.2 | Traceability, provenance | requirement → gate → evidence map; versions recorded; `Assisted-by` trailer | `provenance` |
| 6.3 | Cost per accepted change | cost from agent output, failed attempts counted, per accepted change | `cost`, `metrics` |
| 6.4 | Outcome metrics, visible | report and static dashboard lead with outcomes and stability | `metrics`, `report` |
| 7.1 | Earned autonomy | risk classifier → tier; promotion after N clean releases, demotion on incident | `autonomy` |
| 7.2 | Reversible delivery | patch on new branch, never pushed; rollback target; incident intake | `delivery` |
| 7.3 | Fix delivery first | `doctor`: git, deterministic tests, CI present, profile commands; unattended runs need it | `doctor` |
| 8.1 | Protect review capacity | WIP limit on pending approvals; diff budget; «not verified» list in proof pack | `approvals`, `gates` |
| 8.2 | Engineer comprehension | approval must cite the proof-pack digest; plan + decisions in the proof pack | `approvals`, `report` |
| 8.3 | AI policy, accountability | approved models/tools, unattended classes, data boundary; identities on every approval | `policy/ai-policy` |
| 9.1 | Measured self-improvement | failure intake, registered experiments, held-out audit, can't touch graders, proposal only | `improve` |
| 9.2 | Entropy control | `gc` runs sensors and proposes small cleanup tasks (need intent approval) | `gc` |
| 9.3 | Everything earns its place | gate statistics; conformance registry with negative tests | `metrics`, `conformance` |
| 9.4 | Portable core | stack profiles; agent adapters (Claude Code, generic command, scripted) | `profiles`, `agents` |

## Deliberately not built

A distributed scheduler, containers, signed attestations and production deployment. The factory stops at a reviewed branch and a
recorded rollback target; [trust.md](trust.md) states what infrastructure must add for unattended production use.
