# Principles of an agentic software factory

A working set of 35 principles in nine groups, built from your 13 and from current sources: the StrongDM, OpenAI, Stripe and Uber
write-ups, Anthropic's and HumanLayer's harness guidance, OWASP, DORA, Google SRE and others, plus your own Session 1 deck and
project-factory-next. Compiled 17 October 2026.

**Labels.** `yours` — on your list as is. `refined` — on your list, reworded or sharpened. `new` — not on your list.
**PFN** — what project-factory-next already does, *according to its own docs* (README, architecture, decisions, trust-and-deployment,
self-improvement); not an audit.

## What changed compared with your list

- **Kept as principles, some sharpened:** traceability, observability, cost, requirements, fast feedback, deterministic gates, proof of
  done, simplicity, self-improvement.
- **Moved under the principle they serve**, because they are mechanisms, not principles: the *dashboard* (a way to make outcomes
  visible, 6.4), *subagents* (a way to isolate context, 2.4), *skills* (a way to load knowledge on demand, 2.1–2.2).
- **Split:** «proof of done» became four principles (4.2–4.5); «cost visibility» became visibility, enforcement and unit economics
  (3.3, 6.3); «self-improving» became a separate, measured loop (9.1).
- **Reframed:** «stack-agnostic» → a portable core with stack-specific harness templates, because the stack strongly affects how well
  agents work (9.4).
- **Added: 23 new principles.** The biggest gaps were trust boundaries and security, autonomy policy, production and reversibility,
  resumable state, entropy, and protecting human review capacity.

---

## 1 · Intent and requirements

**1.1 Humans own intent; the factory helps shape it** · `refined` (your #4)
The factory drafts stories, edge cases and prototypes and asks clarifying questions; a human approves the intent before work starts.
A seed can be a spec, a screenshot or an existing working system.
*Check:* every run starts from a human-approved task; open questions are logged, not guessed.
*Sources:* [StrongDM principles](https://factory.strongdm.ai/principles) · [Osmani, The New Software Lifecycle](https://addyosmani.com/blog/new-sdlc-vibe-coding/) · *PFN:* ✓ owner-defined task contracts

**1.2 Admit only work the factory can verify** · `new`
Unattended runs need complete intent: acceptance criteria plus the non-functionals that usually get forgotten (access rules,
idempotency, tenancy, partial failure). Work that can't be checked yet stays interactive.
*Check:* the intake schema rejects tasks without acceptance cases; you track how many tasks are bounced back.
*Sources:* [StrongDM, Shift Work](https://factory.strongdm.ai/techniques/shift-work) · [re:cinq](https://re-cinq.com/blog/building-agent-factories) · *PFN:* partly — strict schemas, every requirement linked to check IDs

**1.3 Research and plan before code, scaled to the task** · `new`
Errors compound: a wrong research finding or plan step produces far more wrong code. For medium and large work, humans review the
research and a short plan (thin vertical slices, each testable as built) instead of the generated diff. Small tasks go straight through.
*Check:* plan artefact approved before implementation; explicit rules for which task sizes get which process.
*Sources:* [HumanLayer, ACE-FCA](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md) · [Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)

## 2 · Context and knowledge

**2.1 The repository is the system of record** · `refined` (your #9)
What the agent can't reach doesn't exist for it. Decisions, specs, execution plans, the tech-debt tracker and quality grades live as
versioned files in the repo, with owners and freshness checks. Skills are one way to package this knowledge.
*Check:* no decision lives only in chat or a doc tool; a recurring job flags stale docs.
*Sources:* [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) · [StrongDM, The Filesystem](https://factory.strongdm.ai/techniques/filesystem)

**2.2 Context is a budget: a map, not a manual** · `new`
A short always-loaded entry point (OpenAI keeps AGENTS.md to about 100 lines as a table of contents), path-scoped rules, skills and
tool schemas loaded on demand, deterministic pre-fetch of what the agent will certainly need, deliberate compaction.
*Check:* size of the always-loaded context is tracked; MCP and tool schemas are not all preloaded.
*Sources:* [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Böckeler, context engineering](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)

**2.3 State lives outside the context window** · `new`
Progress, task lists and checkpoints are persisted (files, git), so any session can stop and another resume without memory of the
first. One owner per run; crashes recover explicitly.
*Check:* kill a run mid-way and resume it without redoing completed work; each session starts with a smoke test and ends in a
mergeable state.
*Sources:* [Anthropic, long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) · *PFN:* ✓ atomic local state, explicit resume

**2.4 Isolated, focused context per step** · `refined` (your #8)
Subagents are context firewalls: they search, read, test or review in a clean window and return a short result. Keep tightly coupled
code-writing in one thread, because parallel writers make conflicting implicit decisions. Add agents only when measurement shows a
gain; multi-agent runs cost many times the tokens of a single agent.
*Check:* each subagent has a brief (objective, output format, tools, boundaries); the gain of each added role is measured.
*Sources:* [Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Cognition, Don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents) · *PFN:* ✓ one worker by default, reviewers only after measured gain

## 3 · Execution control

**3.1 Own the control flow** · `new`
The workflow is a deterministic graph defined in code; lint, test and push are fixed steps, and the model is used only where judgement
is needed. The model proposes an action; your code decides whether and how it runs.
*Check:* the pipeline is defined in code or config, not in a prompt.
*Sources:* [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · [Stripe Minions, part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) · *PFN:* ✓ controller owns workflow state

**3.2 Fast feedback, cheapest check first** · `refined` (your #7)
Order sensors by cost: formatting, lint and types on every edit; tests per change; expensive checks (mutation testing, LLM review) in
the pipeline. Write error messages for the agent: what is wrong and how to fix it. Design tools for agents too: few,
non-overlapping tools, mistake-proof parameters, compact output.
*Check:* time to first signal is measured; custom lint messages contain remediation steps.
*Sources:* [Böckeler, harness engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) · [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) · *PFN:* partly — dependency-ordered checks, bounded failure feedback

**3.3 Bounded runs and an explicit escalation path** · `new`
Hard limits on attempts, time and spend that stop a run, not just alert. After a set number of failed repairs, hand off to a human
with the evidence (Stripe caps CI rounds; GitHub's cloud agent caps sessions at 59 minutes). Keep a tested kill switch that can pause
agents, revoke credentials or disable one tool or MCP server everywhere. Each role states when to stop, whom to ask, and the default if
nobody answers.
*Check:* limits are in config for every run; the kill switch has been rehearsed.
*Sources:* [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [Google SRE, AI in operations](https://sre.google/resources/practices-and-processes/ai-engineering-reliable-operations/) · *PFN:* partly — attempt limits and deadlines; no spend cap or kill switch documented

## 4 · Verification and acceptance

**4.1 Deterministic before judgement** · `yours` (#10)
Lint, types, build, SAST, dependency-existence checks and tests run before any LLM judge. LLM judges see evidence, never the maker's
own account of what it did.
*Check:* gate order is fixed in code; judge prompts exclude the maker's narrative.
*Sources:* [Böckeler, context engineering](https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html) · *PFN:* ✓ deterministic acceptance; no LLM judge

**4.2 Protect the oracle: tests the maker can't change, holdouts it can't see** · `new`
Two separate properties. *Protected*: the acceptance policy is frozen and fingerprinted outside the builder's reach, and the
improvement loop never touches the graders. *Hidden*: holdout scenarios are written from the intent (never from the code), stored
where the builder can't read them, run by a separate process, and reported back only as a count — failure details would turn them into
visible tests. Retire a set once its contents leak. StrongDM's loop ends only when holdout scenarios pass and keep passing.
*Check:* the builder has no write access to tests, evaluators or references and no read access to holdouts; the overfit gap (visible
pass rate minus holdout pass rate) is tracked. Runnable example: [holdout-demo](holdout-demo/README.md).
*Sources:* [StrongDM principles](https://factory.strongdm.ai/principles) · [Willison on StrongDM](https://simonwillison.net/2026/Feb/7/software-factory/) · [Anthropic, long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · *PFN:* protected ✓ (sealed control bundle); hidden — no: a failed attempt's full check results go into the next prompt

**4.3 Evidence over assertions; fail closed** · `new`
A run passes only on complete, content-bound evidence. Missing or empty evidence is a failure. Three outcomes: PASS, NOT-EARNED
(nothing was really checked), FAIL. A model's message can never set the status; a negative report with exit code zero still fails.
*Check:* negative tests prove that «passed» text with missing evidence fails.
*Sources:* your Session 1 deck · [PFN architecture](https://github.com/koldovsky/project-factory-next/blob/main/docs/architecture.md) · *PFN:* ✓ exact result contracts, artefact hashing

**4.4 Independent, adversarial review (maker ≠ checker)** · `new`
Review in a fresh context, ideally with a different model, with no write access to acceptance evidence. Reviewers try to refute each
finding; specialist lenses (security, architecture) beat one generic review. Check the checker by planting known defects.
*Check:* false-pass rate on planted defects is measured.
*Sources:* [re:cinq](https://re-cinq.com/blog/building-agent-factories) · [Pragmatic Engineer, OpenAI's factory](https://newsletter.pragmaticengineer.com/p/openai-software-factory) · *PFN:* in the earlier project-factory (review-gate.js)

**4.5 Layered proof with hard-to-fake oracles** · `refined` (your #11)
Unit, integration and end-to-end tests run the way a user would (in a browser); property-based and mutation testing to test the tests;
evals of both the output and the trajectory (did the agent achieve it or simulate it); satisfaction rates and consistency across
repeated runs instead of a single pass/fail.
*Check:* mutation score; tests shown to fail on the pre-change code; repeated-run consistency.
*Sources:* [Osmani, The New Software Lifecycle](https://addyosmani.com/blog/new-sdlc-vibe-coding/) · [re:cinq](https://re-cinq.com/blog/building-agent-factories) · *PFN:* partly — visual matrix with pixel, geometry, behaviour, overflow and accessibility checks

**4.6 Make the product observable to the agent** · `new`
The agent can boot its own instance of the app, drive the UI, and query that instance's logs, metrics and traces, so it reproduces bugs
and verifies fixes itself. For third-party dependencies, behavioural clones allow high-volume and dangerous-failure scenarios
(StrongDM's Digital Twin Universe).
*Check:* the agent can start the app and read its telemetry inside its sandbox.
*Sources:* [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) · [StrongDM, Digital Twin Universe](https://factory.strongdm.ai/techniques/dtu)

**4.7 Maintainability is a verification target** · `new`
Models are rewarded for passing tests, not for keeping a codebase healthy, and erosion never turns CI red. Enforce architecture and
taste mechanically — dependency direction, structural tests, custom lints — and keep human judgement on design.
*Check:* architecture lints run in CI; duplication and coupling are trended.
*Sources:* [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) · [Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md) · [GitClear](https://www.gitclear.com/the_ai_code_quality_maintainability_gap)

## 5 · Trust boundaries and security

**5.1 Never let one agent hold the lethal trifecta** · `new`
Private data, untrusted content and an outbound channel together turn prompt injection into exfiltration. Give each role at most two,
or put a human gate in front of the third. Output from a subagent that read untrusted content is itself untrusted.
*Check:* a table of roles × the three capabilities, with no row holding all three.
*Sources:* [Willison, The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) · [Beurer-Kellner et al.](https://arxiv.org/abs/2506.08837)

**5.2 Least privilege in a disposable sandbox** · `new`
One fresh environment per task, no production data, default-deny network egress, short-lived task-scoped credentials kept outside the
sandbox behind a scoped proxy. A deterministic policy check inspects consequential tool calls before they run; destructive ones are
blocked or need approval. Boundaries set up front replace per-action prompts (Anthropic reports 84% fewer permission prompts).
*Check:* credential scope per role; egress allowlist; sandbox torn down after each task.
*Sources:* [Anthropic, Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) · [Stripe Minions, part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) · *PFN:* documented as a deployment contract; the local runner is explicitly not a sandbox

**5.3 Separation of duties** · `new`
Agents never approve, merge, release or certify their own work, and the person who requested a change doesn't approve it alone. The
Linux kernel forbids agents from adding Signed-off-by; only a human certifies the contribution.
*Check:* branch protection prevents agent identities from approving or merging.
*Sources:* [GitHub Copilot cloud agent, risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations) · [Linux kernel, coding assistants](https://github.com/torvalds/linux/blob/master/Documentation/process/coding-assistants.rst) · *PFN:* ✓ never grants merge, deploy or self-promotion

**5.4 The factory's own configuration is a supply chain** · `new`
Prompts, skills, agent definitions, hooks, rule files and MCP servers are versioned, reviewed (CODEOWNERS), pinned and rolled out in
stages with rollback. Instruction files are an injection vector; no agent can edit its own gates.
*Check:* CODEOWNERS covers agent config; MCP servers and actions are pinned.
*Sources:* [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [GitHub, guardrails for the cloud agent](https://docs.github.com/en/copilot/tutorials/cloud-agent/build-guardrails) · *PFN:* partly — source CI with SHA-pinned actions, CODEOWNERS

## 6 · Visibility and economics

**6.1 Trace everything in a standard schema** · `refined` (your #2)
Every run, step, tool call, handoff and decision is traced and replayable. Use the emerging OpenTelemetry GenAI conventions; redact
captured prompts and tool arguments, which are sensitive.
*Check:* any run can be reconstructed from its trace alone.
*Sources:* [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) · *PFN:* partly — run store with state transitions and process output

**6.2 Traceability and authorship provenance** · `refined` (your #1)
Requirement ID → spec → tests → change → evidence → release, plus *who made it*: agent, model, factory and skill versions per change.
Trailer conventions differ (the kernel uses `Assisted-by`; there's no cross-industry standard yet), so keep full detail in your own
provenance records.
*Check:* pick any shipped line and walk back to its requirement and evidence; each run records model, prompt, skill and
environment versions, so it can be reproduced.
*Sources:* [Linux kernel, coding assistants](https://github.com/torvalds/linux/blob/master/Documentation/process/coding-assistants.rst) · [Agent Trace (RFC)](https://agent-trace.dev/) · *PFN:* ✓ requirement-to-check IDs, candidate/policy/runtime digests

**6.3 Cost per accepted change** · `refined` (your #3)
Cost per run, stage, agent and model, with failed and abandoned attempts counted. The unit is an *accepted* change under a fixed bar,
not a merged PR or a token. Route tasks to models benchmarked on your own work and re-test regularly. Enforcement lives in 3.3.
*Check:* cost per accepted change is reported; share of spend on failed attempts is visible.
*Sources:* [FinOps for AI](https://www.finops.org/framework/technology-categories/ai/) · [StrongDM, Weather Report](https://factory.strongdm.ai/weather-report) · [Insight APAC](https://blog.apac.insight.com/2026/07/06/cost-to-a-merged-feature) · *PFN:* partly — failure intake records cost; separate dashboard repo

**6.4 Outcome and stability metrics, made visible** · `new` (your #5 dashboard is the mechanism)
Lead with outcomes: accepted rate, escaped defects, change-failure and rework rate, lead time, human minutes per change. Throughput and
stability together; no vanity counts of agents, tokens or PRs. The dashboard, run reports and proof packs make this visible, so humans
review evidence rather than diffs.
*Check:* the dashboard's first screen shows outcomes and stability, not activity.
*Sources:* [DORA 2025](https://dora.dev/research/2025/dora-report/) · [Uber](https://www.uber.com/us/en/blog/efficient-software-factory/) · *PFN:* — (a separate project-factory-dashboard repo was built on 16 October)

## 7 · Autonomy and delivery

**7.1 Risk-tiered, earned autonomy with defined human checkpoints** · `new`
Autonomy reaches only as far as checks can verify cheaply, set per change class and component: docs might auto-merge, app code needs a
human, migrations need two people. Start supervised, widen after measured success, narrow automatically during incidents. Humans sit
at scope, plan, irreversible or outward-facing actions, and release. Gate strictness scales with risk and reversibility — OpenAI runs
minimal blocking merge gates where corrections are cheap.
*Check:* a written autonomy matrix; a risk classifier routes each change.
*Sources:* [AWS, agentic AI security scoping matrix](https://aws.amazon.com/blogs/security/the-agentic-ai-security-scoping-matrix-a-framework-for-securing-autonomous-ai-systems/) · [Google SRE, AI in operations](https://sre.google/resources/practices-and-processes/ai-engineering-reliable-operations/) · [re:cinq](https://re-cinq.com/blog/building-agent-factories)

**7.2 Reversible delivery and production feedback** · `new`
No direct agent path to production. Small batches, feature flags, canaries, automatic rollback triggers, the previous artefact kept
ready. After merge, the change is watched against success and failure signals, and incidents and flaky tests flow back into the queue.
*Check:* rollback rehearsed; escaped defects traced back to the run that produced them.
*Sources:* [DORA AI Capabilities Model](https://cloud.google.com/blog/products/ai-machine-learning/introducing-doras-inaugural-ai-capabilities-model) · [Pragmatic Engineer, OpenAI's factory](https://newsletter.pragmaticengineer.com/p/openai-software-factory) · *PFN:* documented as an external contract (canary, rollback)

**7.3 Fix the delivery system before scaling agents** · `new`
An automated path to production with rollback, stable tests, enough CI capacity, and an agreed view of the current bottleneck.
On legacy code first: reproducible builds and characterisation tests.
*Check:* flaky-test rate and CI queue time are tracked and acceptable before adding agents.
*Sources:* [re:cinq](https://re-cinq.com/blog/building-agent-factories) · [Böckeler, harness engineering memo](https://www.martinfowler.com/articles/exploring-gen-ai/harness-engineering-memo.html)

## 8 · People

**8.1 Protect human review capacity** · `new`
Never produce more than people can genuinely verify. Small diffs, plain-language risk summaries, an explicit list of what was *not*
built or tested, and a watch on approval fatigue and automation bias. This is back pressure applied to humans.
*Check:* review queue age and size; a cap on work waiting for humans.
*Sources:* [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) · [LLVM AI tool policy](https://llvm.org/docs/AIToolPolicy.html)

**8.2 Engineer comprehension** · `new`
Build understanding on purpose, or comprehension debt grows while tests stay green. Humans own specs, architecture decisions and
acceptance scenarios; they review plans; people rotate through incidents and deep reviews; each person runs a manageable number of
agents.
*Check:* an engineer can explain any shipped change from its plan and trace.
*Sources:* [Osmani, Comprehension debt](https://addyosmani.com/blog/comprehension-debt/) · [Osmani, Software factories](https://addyosmani.com/blog/software-factories/)

**8.3 A clear AI policy and personal accountability** · `new`
A written, communicated policy: approved models, tools and MCP servers, what may run unattended, attribution, licence and IP, and a
data boundary per client enforced by the harness. Every privileged action is attributable to a person.
*Check:* the policy exists and the harness enforces the client data boundary.
*Sources:* [DORA AI Capabilities Model](https://cloud.google.com/blog/products/ai-machine-learning/introducing-doras-inaugural-ai-capabilities-model) · [LLVM AI tool policy](https://llvm.org/docs/AIToolPolicy.html)

## 9 · Evolution and discipline

**9.1 Supervised, measured self-improvement in a separate loop** · `refined` (your #6)
Failure intake → one hypothesis → one change → experiment on held-out tasks → independent promotion → canary → rollback if needed.
The improvement loop can't change graders, and harness changes (prompts, skills, tools) get evals like product code.
*Check:* every factory change has an experiment record; the held-out set is used once.
*Sources:* [PFN, measured self-improvement](https://github.com/koldovsky/project-factory-next/blob/main/docs/self-improvement.md) · [Anthropic, writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · *PFN:* ✓

**9.2 Entropy control («garbage collection»)** · `new`
Agents copy the patterns they find, including bad ones. Encode the «golden principles» as rules, and run recurring clean-up agents
that find drift, refresh docs and quality grades, and open small refactoring PRs. OpenAI replaced a weekly manual clean-up day this
way.
*Check:* drift sensors run on a schedule; duplication and quality grades are trended.
*Sources:* [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) · [Osmani, Software factories](https://addyosmani.com/blog/software-factories/)

**9.3 Everything earns its place** · `refined` (your #13)
Start minimal: one worker, one slice. Add a component only when measurement shows a gain. Know each gate's catch rate, false-alarm
rate, cost and latency. Re-evaluate scaffolding when models change, because yesterday's workaround becomes overhead. Every claim of
enforcement points to code and a negative test.
*Check:* per-gate statistics; a decision log with the evidence for each component.
*Sources:* [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · [PFN decisions](https://github.com/koldovsky/project-factory-next/blob/main/docs/decisions.md) · *PFN:* ✓

**9.4 Portable core, stack-specific harness templates** · `refined` (your #12)
Contracts, controller and evidence stay model- and vendor-agnostic; each stack or task family gets its own profile with guides and
sensors. Prefer agent-legible, «boring» technology, strong types and clear module boundaries — the stack affects results. Agents use
the same toolchain as humans: one canonical instruction file, thin per-tool shims.
*Check:* you can switch model or runtime without changing contracts; each production line has a profile.
*Sources:* [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/) · [Böckeler, harness engineering](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) · [Stripe Minions, part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) · *PFN:* ✓ profiles; Codex, Claude Code or manual

---

## Tensions to decide, not paper over

| Tension | One side | Other side | A workable rule |
|---|---|---|---|
| **Subagents** | Specialist reviewers beat a generic one (OpenAI) | Parallel writers conflict; multi-agent costs many times the tokens (Cognition, Anthropic) | Isolate reading, searching and reviewing; keep writing serial; add roles only with measured gain |
| **Gates vs throughput** | Every station gated | OpenAI keeps blocking merge gates minimal and reruns flaky tests; your «mega factory» got too slow | Strictness scales with risk and reversibility (7.1) |
| **Human code and review** | StrongDM and OpenAI: no human-written code, review optional | Stripe reviews every change; HumanLayer went back to review | Decide per risk tier, not per company |
| **Stack-agnostic vs harnessable** | One core for every stack | Stack choice changes agent results | Portable core plus stack-specific templates (9.4) |
| **Self-improvement vs stability** | The factory should learn | Learning can overfit or move the goalposts | Separate loop, held-out audit, one change at a time (9.1) |
| **Observability vs privacy and cost** | Capture everything | Prompts and tool arguments are sensitive and costly to store | Trace structure always; capture content opt-in and redacted (6.1) |

*Numbers are limited to ones checked first-hand: OpenAI's post (read directly), StrongDM's principles page, and the sources already
cited in the Session 1 deck. Other figures in the research summaries were left out.*
