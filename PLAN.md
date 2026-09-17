# ReasonateAI Phase 3 — Final Project Plan

## 1. Product goal

ReasonateAI Phase 3 is an autonomous, multimodal “AI CTO” for nontechnical users. A user describes a product through voice, chat, screenshots, wireframes, or flowcharts. The system converts that intent into an editable project specification, builds the software, launches it in an isolated environment, inspects its actual behavior, repairs failures, and reports progress through text and speech.

The MVP is successful only when it demonstrates the complete loop:

> understand → plan → build → run → inspect → repair → verify → present

Generating source code or passing a compilation step alone does not constitute completion.

## 2. Delivery constraints

- **MVP feature freeze:** October 8, 2026.
- **Live delivery:** October 13, 2026.
- **Schedule extensions:** none.
- **Implementation language:** TypeScript wherever practical; Python model-serving processes are permitted where required by the model ecosystem.
- **Model policy:** no architectural dependency on closed frontier models or uncapped expensive APIs. Open-weight hosted inference may be used for the deadline behind provider-neutral Spectra adapters and strict spending limits. Local inference remains supported.
- **Blocked integrations:** use explicit mock adapters only when a real external account or credential is unavailable. Mocks must be visible in the UI and replaceable through the same contract; they must not masquerade as completed production integrations.

## 3. MVP scope

The MVP will support one complete target platform: TypeScript web applications. It will provide:

1. Chat, voice, and image-based product intake.
2. Editable requirements, architecture, acceptance criteria, and implementation plan.
3. One executive coding agent that owns the task end to end.
4. Optional temporary subagents for genuine parallel work, independent review, or context isolation.
5. Workspace tools for reading, searching, editing, language intelligence, execution, browser interaction, and Git checkpoints.
6. A unified resource system for files, skills, rules, agent outputs, artifacts, memory, MCP resources, project state, run evidence, and previews.
7. Isolated application execution with captured logs, process state, test results, preview URLs, and screenshots.
8. Browser-based inspection of the generated application.
9. Evidence-driven repair loops with bounded retries and precise escalation.
10. Persistent sessions, project state, artifacts, decisions, and resumable execution.
11. Text and speech milestone reporting.
12. Human handoff for credentials and genuinely ambiguous product decisions.

Deferred until after the MVP:

- Native Android and iOS generation and emulator verification.
- Unrestricted user-authored executable skills.
- A vector database in the critical path.
- Fully autonomous production-cloud deployment.
- A permanent hierarchy of architect, frontend, backend, QA, and DevOps services.
- Broad support for arbitrary programming languages and frameworks.

## 4. Core architectural decision

ReasonateAI will use a **single executive agent by default**. It may create bounded, temporary workers when delegation offers measurable value. Agent roles are task-specific prompts and permission sets, not permanent services.

Subagents are appropriate only when:

- independent work can execute concurrently;
- a clean context boundary improves review quality;
- another model or tool set is materially better for the task;
- a large investigation would pollute the executive context; or
- an adversarial verification pass is required.

The executive agent remains responsible for integration and final verification.

## 5. Foundation: Spectra

ReasonateAI will build on Spectra rather than create another general-purpose agent framework.

- `@mohanscodex/spectra-ai`: provider abstraction, model registry, streaming, multimodal messages, usage, and pricing.
- `@mohanscodex/spectra-agent`: agent loop, typed tools, steering, retries, aborts, skills, and bounded delegation.
- `@mohanscodex/spectra-app`: session lifecycle, persistence, rate limiting, circuit breaking, worker execution, and streaming events.
- `@mohanscodex/spectra-code`: proven coding-agent tools, security controls, sessions, memory, skills, MCP, and user interaction patterns.

ReasonateAI-specific policy and state will remain in product packages instead of being embedded into Spectra’s generic agent core.

## 6. Unified resource architecture

Spectra will receive an Oh My Pi-style resource subsystem. One `read` tool will resolve ordinary paths, URLs, documents, archives, databases, images, and registered internal URI schemes.

Initial schemes:

- `skill://` — immutable bundled, user, and project skills.
- `rule://` — active behavioral and project rules.
- `agent://` — typed outputs from current or persisted agents, with structured extraction.
- `artifact://` — recoverable large or truncated tool output.
- `memory://` — scoped project, user, and session memory.
- `local://` — session-local files and shared task artifacts.
- `mcp://` — resources exposed by connected MCP servers.
- `history://` — persisted agent histories.
- `project://` — canonical specification, architecture, decisions, plan, and acceptance criteria.
- `run://` — sandbox commands, logs, test reports, processes, and runtime state.
- `preview://` — screenshots, accessibility trees, network records, and browser console output.
- `git://` — read-only commits, checkpoints, and diffs.
- `sandbox://` — sandbox files and status.

Design rules:

- Resources are nouns addressed by URIs; tools are verbs that perform actions.
- Every protocol declares whether its resources are immutable.
- Write support is opt-in per protocol; read-only resources cannot be modified.
- Resolution is project- and session-aware.
- Selectors, ranges, pagination, raw mode, document conversion, and artifact recovery behave consistently across resource types.
- Protocol handlers validate traversal, authorization, resource ownership, and size limits.
- Large outputs return stable artifact references instead of disappearing after truncation.
- Skills and rules remain outside the permanent prompt and are read on demand.

## 7. Model strategy

### Executive model

The initial executive model is DeepSeek V4.1 Flash because it combines coding, long-context reasoning, native visual understanding, controllable reasoning effort, and an open-weight MIT release. Spectra’s provider abstraction must prevent DeepSeek-specific coupling.

The production choice will be determined by **cost per verified completed task**, not token price or vendor benchmark alone. Evaluations will measure:

- successful end-to-end completion rate;
- valid tool-call rate;
- edit success rate;
- repair iterations;
- visual acceptance rate;
- elapsed time;
- total inference cost; and
- behavior under context pressure.

Current GLM, Qwen, Kimi, and MiniMax agentic releases remain evaluation candidates.

### Speech input

- Default: Qwen3-ASR 0.6B for low-latency local streaming.
- Quality option: Qwen3-ASR 1.7B.
- Alignment: Qwen3-ForcedAligner when timestamps are required.
- Alternatives evaluated on the intended languages and hardware: VibeVoice-ASR, NVIDIA Canary, and Parakeet.

### Speech output

- Default: Qwen3-TTS 0.6B or 1.7B according to latency and quality requirements.
- Streaming alternative: CosyVoice.
- Lightweight alternatives: Chatterbox Turbo and Pocket TTS.

Speech models remain replaceable services behind stable streaming contracts.

## 8. System components

### 8.1 Interaction application

A responsive web/PWA interface provides:

- voice recording and live transcription;
- text chat;
- image and document upload;
- generated clarification forms;
- editable project specification and plan;
- execution timeline and current agent activity;
- permission and credential requests;
- live application preview;
- screenshot and artifact inspection;
- rollback controls; and
- streaming speech updates.

### 8.2 Executive runtime

The runtime combines Spectra’s agent loop with ReasonateAI policy:

- establishes or updates project intent;
- maintains acceptance criteria and active plan;
- retrieves only relevant resources;
- chooses tools and models based on capability and cost;
- delegates bounded tasks when justified;
- checkpoints before risky write phases;
- runs and visually inspects generated software;
- repairs evidence-backed failures; and
- escalates only when human-owned information is required.

### 8.3 Project state

Canonical durable state includes:

- product specification;
- architecture and API contracts;
- acceptance criteria;
- active plan and task status;
- decisions and rejected alternatives;
- external integration requirements;
- agent runs and tool events;
- verification evidence;
- artifacts and previews;
- Git checkpoints; and
- human requests and responses.

SQLite is the initial source of truth. Large artifacts live in filesystem or object storage. Full-text search and URI selectors precede vector retrieval. Embeddings are added only when measured retrieval failures justify them.

### 8.4 Workspace and editing

The workspace layer provides:

- selective reads and fast searches;
- hash-anchored edits with stale-content rejection;
- language-server definitions, references, diagnostics, code actions, and refactors;
- debugger integration for runtime failures;
- programmatic Python and Bun execution capable of calling approved harness tools;
- Git checkpoints linked to agent turns; and
- isolated worktrees for concurrent writing agents.

### 8.5 Sandbox

A provider-neutral `SandboxProvider` contract owns:

- creation and destruction;
- command and process execution;
- controlled network access;
- brokered secrets;
- port exposure and previews;
- snapshots and restore;
- artifact collection; and
- resource and timeout limits.

Tencent CubeSandbox will be evaluated through this interface. Docker may serve local development, but production execution should prefer a stronger isolation boundary such as a microVM or user-space kernel with deny-by-default egress and brokered credentials.

### 8.6 Verification and repair

Every coding task has observable completion criteria. The loop is:

1. Checkpoint the workspace.
2. Implement the smallest coherent change.
3. Start the real application in the sandbox.
4. Exercise the changed user path.
5. Capture logs, browser console, network activity, screenshot, and relevant test results.
6. Classify failures using evidence.
7. Repair the owning code path.
8. Re-run the exact failed scenario.
9. Stop after the configured retry and cost budget.
10. Escalate with the evidence, attempted fixes, and exact missing prerequisite.

## 9. Repository shape

```text
apps/
  web/                    User-facing AI CTO PWA
  api/                    Projects, sessions, artifacts, auth, and events
  worker/                 Durable executive-agent jobs
  voice-gateway/          Streaming ASR and TTS process gateway

packages/
  contracts/              Shared Zod schemas and domain events
  cto-runtime/            Executive policy built on Spectra
  resource/               Unified resource router and protocol handlers
  project-state/          Persistence and resumable execution
  sandbox/                SandboxProvider and implementations
  verification/           Run, browser, and evidence contracts
  model-evals/            Repeatable harness/model evaluation scenarios
  ui/                     Shared interface components

services/
  qwen-asr/
  qwen-tts/

infra/
  compose/
  sandbox/
  deployment/
```

Spectra remains a dependency or workspace sibling. Generic improvements such as the unified resource system belong in Spectra and are consumed by ReasonateAI.

## 10. Security invariants

- Generated code never receives host Docker sockets or control-plane credentials.
- Network egress is deny-by-default or allowlisted for untrusted execution.
- Secrets are brokered and never returned through `read`, logs, screenshots, agent output, or environment dumps.
- Internal resource resolution is scoped by project, session, user, and agent permissions.
- Path traversal and symlink escape are rejected.
- Bundled skills and sealed artifacts are immutable.
- Every state-changing tool call is auditable.
- Tool retries, agent turns, execution time, and spend are bounded.
- Repeated identical tool behavior triggers doom-loop protection.
- External content is treated as untrusted data, not instructions.

## 11. Delivery schedule

### September 16–18: foundation and contracts

- Finalize product scope and acceptance scenarios.
- Establish the ReasonateAI monorepo and Spectra dependency workflow.
- Port the complete OMP-style unified read/resource subsystem into Spectra.
- Define project-state, sandbox, artifact, run, preview, and delegation contracts.
- Benchmark the initial executive, ASR, and TTS candidates on available hardware.

Exit criterion: Spectra can resolve files, skills, rules, agent outputs, artifacts, memory, and MCP resources through one tested read surface.

### September 19–23: executive vertical slice

- Implement project creation and persistent sessions.
- Add text and image intake.
- Generate editable specification, acceptance criteria, and plan.
- Connect the executive runtime to a controlled TypeScript workspace.
- Add Git checkpoints and structured task state.

Exit criterion: a text/image request produces a persistent plan and a generated repository through the executive agent.

### September 24–29: execution and feedback

- Integrate the sandbox provider.
- Capture commands, processes, logs, tests, and preview state.
- Add real-browser launch, interaction, accessibility-tree retrieval, console capture, and screenshots.
- Implement evidence-driven failure classification and bounded repair.

Exit criterion: the system generates, launches, observes, repairs, and re-verifies a web application.

### September 30–October 3: voice and human handoff

- Integrate streaming Qwen3-ASR.
- Integrate the selected streaming TTS model.
- Add spoken milestones with matching textual events.
- Add credential metadata, secure submission, pause, and resume.
- Add clarification and approval forms.

Exit criterion: a user can begin through voice, satisfy a human handoff, and receive a spoken verified result.

### October 4–7: evaluation and hardening

- Run fixed end-to-end product scenarios.
- Measure cost per verified task and repair-loop behavior.
- Test interruption, resume, rollback, timeout, model failure, sandbox failure, and missing credentials.
- Enforce project/session isolation and artifact authorization.
- Resolve critical UX and reliability failures only.

Exit criterion: the selected demonstration scenarios pass repeatedly from clean project creation.

### October 8: feature freeze

- Freeze scope, contracts, models, and demonstration workflows.
- Produce the release candidate.
- Record known limitations explicitly.

### October 9–13: delivery buffer

- Fix release-blocking defects only.
- Deploy the live MVP.
- Rehearse the demonstration from a clean user account.
- Prepare operational runbooks and fallback model/sandbox configurations.

## 12. Ownership boundaries

### Mohana Krishna

- Spectra integration and generic runtime improvements.
- Unified resource/read subsystem.
- Executive agent loop and adaptive delegation.
- Project/session persistence, context engineering, and recovery.
- Skills, memory, permissions, and failure controls.
- Git checkpoints and end-to-end verification architecture.
- Cross-component contracts and final integration.

### Sandbox owner

- `SandboxProvider` implementation.
- Isolation lifecycle, snapshots, command execution, process supervision, previews, and artifact capture.
- Network and secret-isolation controls.
- Integration with `run://`, `preview://`, and `sandbox://` resources.

### UI owner

- Voice/chat workflow.
- Specification and plan editing.
- Activity, approval, artifact, preview, and rollback interfaces.

### Model/voice owner

- Executive-model serving and benchmarks.
- Qwen3-ASR streaming service.
- TTS benchmarking and service integration.
- Hardware-specific latency and concurrency measurements.

## 13. MVP acceptance scenario

From a clean account and project:

1. The user speaks a small web-application idea and uploads a rough wireframe.
2. The system transcribes the request and extracts the visual intent.
3. The executive produces an editable specification, acceptance criteria, and plan.
4. The user approves the plan through the interface.
5. The executive builds the TypeScript application using Spectra tools.
6. The application starts in an isolated sandbox.
7. The system opens the real preview, interacts with the principal flow, and captures visual and runtime evidence.
8. At least one controlled defect is detected and repaired using the same failed scenario.
9. The final flow is re-run successfully.
10. The user receives a live preview, evidence summary, source checkpoint, and spoken completion report.
11. The project can be closed, reopened, and resumed without losing decisions, state, or artifacts.
12. The user can restore the preceding Git checkpoint from the interface.

This scenario, completed reliably and without hidden manual code correction, is the definition of the Phase 3 MVP.