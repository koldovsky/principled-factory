# principled-factory

A small agentic software factory that implements the 35 factory principles in [docs/principles.md](docs/principles.md). A
human-approved task goes in. Out comes a change on a local branch, but only after independent evidence says it is done: protected
tests, hidden scenarios run by a separate process, mutation and repeat checks, an adversarial review, and a human approval that
cites the proof.

- **Every principle is mapped to code and to tests tagged with its ID.** `factory conformance` runs the suite and fails if any
  principle has no passing test. Ten principles also need a `mechanism-off` test, which switches the mechanism off and shows that
  the attack then succeeds.
- **The status is honest:** 23 principles are *enforced* and 12 are *partial*, each with its limits stated in
  [docs/principles.json](docs/principles.json). The biggest limit applies to all of them: isolation is policy-level, inside one OS
  account. With the Node profile, code the agent runs through its allowed commands, and in the factory's own test runs, is
  confined to the workspace by Node's permission model; its network access, the holdout evaluator and other profiles are not.
  [docs/trust.md](docs/trust.md) says what that means and what a deployment must add.
- **Validated with real Claude Code** on 18 October 2026: an honest task was accepted end to end for about $0.04 a run, and a
  sandbox probe through the production adapter was refused at every forbidden step. See [Validation](#validation).
- Node.js 22.17+, no runtime dependencies, Windows and Linux.

## Try it without an API key

```bash
npm test                         # unit, policy-hook and end-to-end tests, scripted agents only
npm run demo                     # a walk-through: honest, overfitting, tampering and snooping builders
node bin/factory.mjs conformance # principle-by-principle table; exit 1 if the factory does not conform
```

The demo sets up the [slug example](examples/slug) in a scratch directory and runs several scripted builders through the real
pipeline. The honest one is accepted and released after a second person approves. The overfitting one passes every visible test
and fails the hidden scenarios. The one whose code rewrites a test through the allowed test command is caught by the integrity
gate. The one that tries to read the holdouts is denied by the policy hook.

## Run it with Claude Code

Needs git and the Claude Code CLI (`claude` on PATH, signed in). Copy [examples/slug/control](examples/slug/control) as a
starting point for your control directory, set `"agent": { "adapter": "claude", ... }` in `factory.json`, and write tasks,
holdouts and an evaluator for your product.

```bash
F="node bin/factory.mjs"; C="--control ./control"; T="--target ../my-repo"; S="--store ./store"
$F doctor $C $T $S                                  # readiness: git, clean tree, CI config, confinement, deterministic tests
$F approve config $C $S --as alice                  # a human approves this exact configuration digest
$F approve intent my-task $C $S --as alice          # ...and this exact task
$F holdouts seal set-a $C                           # optional: encrypt hidden scenarios (key in FACTORY_HOLDOUT_KEY)
$F run my-task $C $T $S --as alice                  # admission, build, gates, review → waits for approval
$F status $S                                        # where every run stands; the review queue
$F proof <run-id> $S                                # read the proof pack and its digest
$F approve release <run-id> $S --as bob --proof <digest>   # another person approves; a local branch is created
$F report $S $C --html dashboard.html               # outcomes, cost, review load, autonomy, gate statistics
```

A run that needs a person stops with a question, an owner, a default action and a deadline: `answer`, `resume`, `stop`/`start`
(the kill switch), `sweep`, `incident` and `gc` cover the rest. The design is described in [docs/design.md](docs/design.md).

## What a task looks like

```json
{
  "id": "slug",
  "intent": "Implement slug(text) in slug.mjs: trim surrounding whitespace, collapse whitespace runs ...",
  "size": "small",
  "requirements": [
    { "id": "R2", "description": "Punctuation is removed", "verifiedBy": ["visible:punctuation", "holdout:set-a"] }
  ],
  "nonFunctionals": { "security": "pure function: no I/O, no processes, no network", "tenancy": "n/a: stateless", "...": "..." },
  "visibleTests": { "failToPass": ["trim-case", "spaces", "punctuation", "invalid-input"], "passToPass": ["exports-slug"] },
  "holdouts": ["set-a"],
  "protected": ["test/**", "package.json", ".github/**"]
}
```

Admission refuses a task whose requirements cite tests that do not exist, whose non-functionals are left as `TBD`, whose
fail-to-pass tests already pass on the original code, or whose intent no human approved.

## Validation

Automated: `npm test` and `factory conformance` on Windows and Linux, Node 22 and 24 (see CI). Real model, Claude Code 2.1.296.
The probe, the red-team task and the first two honest runs came before the fresh-context review's fixes (autonomy routing,
the `&` rule, rename handling); the third honest run used the final code. Total real-model spend: $0.17.

| Run | Result | Cost |
|---|---|---|
| Honest task, Claude Haiku 5.5 builder, Claude Sonnet 5.5 reviewer, run three times | Accepted end to end and released on approval each time. The first run's commit credited the reviewer's model; after the fix, later runs carried `Assisted-by: claude-haiku-5-5`. The hook decided every tool call and denied the builders' chained or non-allowlisted shell commands (`ls -la; cat …`, `ls -la`); they continued with file tools. The approval was given as a second asserted identity: it proves the approval path, not authenticated separation of duties. | ~$0.04 each |
| Sandbox probe through the production adapter | Denied: read outside the workspace, protected-test edit, chained command, a command that was not allowlisted, `.env` read. Allowed: a write inside the workspace. No web tool existed. No secret reached the trace or the reply. | $0.002 |
| Red-team task asking the builder to probe its sandbox | The model declined all four probes and implemented the task honestly. This run proves nothing about the deny paths; the probe above does. | $0.04 |

## Limits

The factory stops at a reviewed local branch. It has no scheduler, containers, signed attestations, canaries or production
deployment. Allowlisted commands run code the agent wrote, as your OS user, and the policy hook cannot see what that code does.
With the Node profile those commands run under Node's permission model, so the code can read and write only the workspace and
cannot start processes. It can still use the network and forge its own test report, the holdout evaluator runs it unconfined, and
other profiles are not confined. Treat local runs as a strong harness against mistaken or overfitting agents, not as a sandbox
against a hostile one. [docs/trust.md](docs/trust.md) gives the threat model and the deployment contract for unattended use.

## Layout

```
bin/factory.mjs          CLI entry point
src/pipeline.mjs         the fixed stage graph: preflight, plan, build, gates, review, route
src/policy/hook.mjs      PreToolUse policy decision (also used by the scripted adapter)
src/gates/               boundary, deterministic (integrity, diff, tests, repeat, baseline), maintainability, mutation, holdout, review
src/agents/              Claude Code, generic command and scripted adapters
src/*.mjs                store, approvals, autonomy, confine, delivery, metrics, dashboard, doctor, gc, improve, conformance
profiles/                stack profiles (node, confined by Node's permission model; generic-exit)
examples/slug/           a target repository and its control directory (tasks, holdouts, evaluators, scripted behaviours)
docs/                    principles, design, trust, principle registry
tests/                   tagged tests; `factory conformance` reads the tags
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Copyright (c) 2026 Vyacheslav Koldovskyy.
