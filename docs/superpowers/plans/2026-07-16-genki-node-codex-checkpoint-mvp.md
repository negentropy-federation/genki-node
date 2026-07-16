# Genki Node Codex And Checkpoint MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the working local Genki Node MVP with a provider-neutral task orchestrator, Agy and Codex task adapters, automatic partial checkpoints, and a testable Federation One lease client.

**Architecture:** Core owns sessions, task state, workspaces, patches, validation, checkpoints, and cleanup. Thin host adapters run one fresh Agy or Codex process per prepared task, while a coordinator interface supplies leases and acknowledges idempotent checkpoint/result uploads. The first implementation uses controlled local repositories plus an in-process fake coordinator; arbitrary remote repositories stay disabled until the outer sandbox acceptance gate passes.

**Tech Stack:** Node.js 22.18+, TypeScript 6.0.3, Zod 4.4.3, MCP TypeScript SDK 1.29.0, Vitest 4.1.10, ESLint 10.7.0, npm, Agy CLI 1.1.2, Codex CLI 0.144.2+.

## Global Constraints

- Hosts are exactly `agy` and `codex` in this plan.
- One user authorization covers one bounded contribution session; no per-task, patch, checkpoint, or final-result confirmation is added.
- Every task starts a fresh host process and fresh model conversation.
- Provider credentials remain under the native local host; Genki never reads, copies, serializes, or uploads them.
- Personal-plan adapters are experimental and carry no availability or production-capacity promise.
- API, BYOK, enterprise, local-model, and Claude adapters are excluded.
- Only controlled local fixtures are executable until outer-sandbox acceptance tests pass.
- Remote task schema accepts only public repositories with accepted SPDX licenses and immutable base commits.
- Task execution network is `none`; dependency-domain support is schema-only in this plan.
- Final patches and partial checkpoints upload automatically while the session authorization remains valid.
- Checkpoints contain code state and bounded summaries, never conversation history, hidden reasoning, or raw host transcripts.
- Optional email is unverified private metadata, not authentication or ownership proof; anonymous contributions cannot be recovered.
- Attempt Signal is server-calculated, capped at one percent of normal task Signal, and subject to a daily cap.
- Cleanup is deterministic local code and succeeds without Agy, Codex, network, or model quota.
- The existing 74-test local Agy MVP behavior remains covered throughout the refactor.

---

## File Map

- `packages/core/src/types.ts`: provider-neutral sessions, tasks, leases, checkpoints, host outcomes, and usage evidence.
- `packages/core/src/schema.ts`: strict versioned parsing for session policy and leased tasks.
- `packages/core/src/state-machine.ts`: session and task/checkpoint transitions.
- `packages/core/src/engine.ts`: provider-neutral prepare, validate, checkpoint, finalize, and cleanup lifecycle.
- `packages/core/src/result.ts`: retained local result and checkpoint artifacts for tests.
- `packages/core/src/repository.ts`: immutable-base checkout, patch build, and checkpoint application.
- `packages/hosts/src/types.ts`: `HostAdapter` contract and availability/result types.
- `packages/hosts/src/process.ts`: abortable, timeout-bounded child-process runner with in-memory output limits.
- `packages/hosts/src/codex.ts`: one-task non-interactive Codex adapter and JSONL parser.
- `packages/hosts/src/agy.ts`: one-task non-interactive Agy adapter.
- `packages/coordinator/src/types.ts`: lease, heartbeat, checkpoint, result, and session interfaces.
- `packages/coordinator/src/local.ts`: adapter for the current local task directory and result sink.
- `packages/coordinator/src/http.ts`: Federation One HTTP client with idempotency keys and redacted errors.
- `packages/orchestrator/src/session.ts`: contribution loop that binds coordinator, engine, and host adapter.
- `packages/cli/src/args.ts`: `--host agy|codex` and coordinator options.
- `packages/cli/src/consent.ts`: approved session summary including automatic uploads and optional contributor fields.
- `packages/cli/src/bin.ts`: session setup, orchestrator launch, stop, status, and cleanup.
- `packages/cli/src/agy.ts`: removed after migration to `packages/hosts/src/agy.ts`.
- `packages/mcp-server/`: retained for Agy plugin compatibility during migration, then limited to status/stop compatibility tools.
- `plugins/agy/skills/genki-contribution/SKILL.md`: starts or reports Genki contribution mode instead of owning the task loop.
- `tests/fake-hosts/`: executable Agy/Codex fixtures for deterministic process tests.
- `tests/fake-coordinator/`: in-process HTTP coordinator with lease-generation and idempotency behavior.
- `tests/local-harness/`: end-to-end consent, execution, checkpoint, continuation, privacy, and cleanup tests.
- `plugins/codex/genki-node/`: scaffolded Codex plugin whose folder and manifest names both equal `genki-node`.
- `README.md`: Agy/Codex setup, experimental-plan boundary, privacy, sandbox gate, and local smoke instructions.

---

### Task 1: Provider-Neutral Policies And State

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/state-machine.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/args.ts`
- Test: `packages/core/src/schema.test.ts`
- Test: `packages/core/src/state-machine.test.ts`
- Test: `packages/cli/src/args.test.ts`

**Interfaces:**
- Produces: `type HostName = "agy" | "codex"`
- Produces: `type HostOutcomeCode = "completed" | "quota_exhausted" | "capacity_unavailable" | "authentication_failed" | "host_failed" | "interrupted" | "timed_out"`
- Produces: `parseSessionPolicy(input: unknown): SessionPolicy`
- Produces: `parseLeasedTask(input: unknown): LeasedTask`
- Produces: task transitions through `checkpointing`, `uploading_checkpoint`, and `checkpointed`.

- [ ] **Step 1: Write failing host and lease schema tests**

Add test fixtures with these exact discriminants:

```ts
const codexPolicy: SessionPolicy = {
  ...validPolicy,
  host: "codex"
};

const leasedTask: LeasedTask = {
  schemaVersion: "2",
  taskId: "parser-fix",
  revision: 1,
  leaseId: "lease-1",
  leaseGeneration: 1,
  leaseExpiresAt: "2026-07-16T12:00:00.000Z",
  project: {
    projectId: "federation-os",
    repositoryUrl: "https://github.com/negentropy-federation/os-lab.git",
    licenseSpdx: "Apache-2.0",
    baseCommit: "0123456789012345678901234567890123456789"
  },
  goal: "Fix the parser without changing its public API.",
  acceptanceCriteria: ["The parser regression test passes."],
  validation: [{ argv: ["npm", "test"], timeoutSeconds: 300 }],
  policy: {
    maxRuntimeSeconds: 900,
    maxChangedFiles: 5,
    maxPatchBytes: 200_000,
    executionNetwork: "none",
    dependencyDomains: []
  },
  predecessorCheckpoint: null
};
```

Prove unknown hosts, non-HTTPS repository URLs, mutable base refs, unknown
licenses, non-`none` execution network, expired leases, shell-string validation,
and unknown keys fail parsing.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- packages/core/src/schema.test.ts packages/core/src/state-machine.test.ts packages/cli/src/args.test.ts
```

Expected: FAIL because Codex, leased-task schema v2, and checkpoint states do not
exist.

- [ ] **Step 3: Add exact provider-neutral types and schemas**

Add:

```ts
export type HostName = "agy" | "codex";

export type HostOutcomeCode =
  | "completed"
  | "quota_exhausted"
  | "capacity_unavailable"
  | "authentication_failed"
  | "host_failed"
  | "interrupted"
  | "timed_out";

export interface HostUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
```

Change `SessionPolicy.host` and `SessionDescription.summary.host` to
`HostName`. Add strict Zod schemas for `LeasedTask`, `PartialCheckpoint`, and
their nested records. Keep the existing local `TaskDefinition` schema v1 for
backward-compatible fixture tests.

- [ ] **Step 4: Add checkpoint transitions**

Extend `TaskState` with:

```ts
| "checkpointing"
| "uploading_checkpoint"
| "checkpointed"
| "uploading_result"
```

Allow only:

```text
executing -> validating | checkpointing | failed | frozen
checkpointing -> uploading_checkpoint | failed | frozen
uploading_checkpoint -> checkpointed | failed
validating -> finalizing | failed | frozen
finalizing -> uploading_result | failed | frozen
uploading_result -> delivered | failed
checkpointed -> purged
```

- [ ] **Step 5: Support `--host agy|codex` and verify GREEN**

Parse both values and preserve `agy` as the default. Run:

```bash
npm run lint && npm run typecheck && npm test -- packages/core/src/schema.test.ts packages/core/src/state-machine.test.ts packages/cli/src/args.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/cli/src/args.ts packages/cli/src/args.test.ts
git commit -m "feat: make Genki sessions host neutral"
```

---

### Task 2: Bounded Host Process Runner

**Files:**
- Create: `packages/hosts/src/types.ts`
- Create: `packages/hosts/src/process.ts`
- Create: `packages/hosts/src/process.test.ts`
- Create: `packages/hosts/src/index.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `HostAdapter.checkAvailability(): Promise<HostAvailability>`
- Produces: `HostAdapter.runTask(input: HostRunInput): Promise<HostRunResult>`
- Produces: `runHostProcess(input: HostProcessInput): Promise<HostProcessResult>`

- [ ] **Step 1: Write failing process-boundary tests**

Test an executable fixture that writes bounded stdout/stderr, sleeps past a
timeout, and handles `SIGTERM`. Assert:

- argument arrays use `shell: false`;
- output is capped at 256 KiB per stream;
- timeout sends `SIGTERM`, then `SIGKILL` after two seconds;
- an `AbortSignal` terminates the process;
- no task text is included in thrown error messages;
- the environment includes only `PATH`, locale, terminal, temporary home,
  provider-required state roots, and explicit Genki identifiers.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- packages/hosts/src/process.test.ts
```

Expected: FAIL because `runHostProcess` does not exist.

- [ ] **Step 3: Define the host interfaces**

Use:

```ts
export interface HostRunInput {
  sessionId: string;
  taskId: string;
  attemptId: string;
  workspace: string;
  instructions: string;
  model: string | null;
  timeoutSeconds: number;
  temporaryHome: string;
  abortSignal: AbortSignal;
}

export interface HostRunResult {
  host: HostName;
  outcome: HostOutcomeCode;
  exitCode: number | null;
  usage: HostUsage | null;
  completedCriteria: string[];
  remainingCriteria: string[];
}

export interface HostAdapter {
  readonly name: HostName;
  checkAvailability(): Promise<HostAvailability>;
  runTask(input: HostRunInput): Promise<HostRunResult>;
}
```

- [ ] **Step 4: Implement the bounded runner and verify GREEN**

Use `spawn()` with `shell: false`, piped stdio, an in-memory bounded buffer, and
explicit timeout/abort cleanup. Do not write host output to the terminal.

Run:

```bash
npm run typecheck && npm test -- packages/hosts/src/process.test.ts
```

Expected: PASS with no child process left running.

- [ ] **Step 5: Commit**

```bash
git add packages/hosts tsconfig.json
git commit -m "feat: add bounded host adapter interface"
```

---

### Task 3: Codex One-Task Adapter

**Files:**
- Create: `packages/hosts/src/codex.ts`
- Create: `packages/hosts/src/codex.test.ts`
- Modify: `packages/hosts/src/index.ts`
- Create: `tests/fake-hosts/fake-codex.mjs`

**Interfaces:**
- Produces: `buildCodexArgs(input: CodexTaskOptions): string[]`
- Produces: `parseCodexJsonl(text: string): ParsedCodexRun`
- Produces: `class CodexHostAdapter implements HostAdapter`

- [ ] **Step 1: Write failing Codex argument tests**

Assert the exact arguments include:

```ts
[
  "exec",
  "--ephemeral",
  "--sandbox", "workspace-write",
  "-c", 'approval_policy="never"',
  "-c", "sandbox_workspace_write.network_access=false",
  "--ignore-user-config",
  "--ignore-rules",
  "--json",
  "--output-schema", schemaPath,
  "-C", workspace,
  "-"
]
```

When a model is selected, insert `--model <model>` before `-`. Prove the task
instructions are sent through stdin and never appear in argv.

- [ ] **Step 2: Write failing JSONL and outcome tests**

Use fixture events:

```jsonl
{"type":"thread.started","thread_id":"thread-local-only"}
{"type":"turn.started"}
{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":10}}
```

Assert usage is parsed, thread IDs and raw events are not returned, malformed
lines fail closed, explicit usage-limit messages classify as `quota_exhausted`,
authentication errors classify as `authentication_failed`, repeated transient
failures classify as `capacity_unavailable`, timeout classifies as `timed_out`,
and abort classifies as `interrupted`.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npm test -- packages/hosts/src/codex.test.ts
```

Expected: FAIL because the Codex adapter does not exist.

- [ ] **Step 4: Implement availability and one-task execution**

`checkAvailability()` runs `codex --version` with a five-second timeout and
requires version `0.144.2` or newer. `runTask()` writes the final-response JSON
schema inside the marked run directory, launches Codex with the exact bounded
arguments, passes instructions through stdin, parses JSONL in memory, and
returns only normalized outcome, usage, and acceptance-criteria arrays.

The final schema is:

```json
{
  "type": "object",
  "properties": {
    "completedCriteria": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 32 },
    "remainingCriteria": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 32 }
  },
  "required": ["completedCriteria", "remainingCriteria"],
  "additionalProperties": false
}
```

Never persist JSONL, final prose, reasoning, command output, or the Codex thread
ID.

- [ ] **Step 5: Verify with the fake host**

Run:

```bash
npm run typecheck && npm test -- packages/hosts/src/codex.test.ts
```

Expected: PASS and the fake host records no instructions in its argv fixture.

- [ ] **Step 6: Commit**

```bash
git add packages/hosts tests/fake-hosts/fake-codex.mjs
git commit -m "feat: add ephemeral Codex task adapter"
```

---

### Task 4: Agy One-Task Adapter

**Files:**
- Create: `packages/hosts/src/agy.ts`
- Create: `packages/hosts/src/agy.test.ts`
- Modify: `packages/hosts/src/index.ts`
- Delete: `packages/cli/src/agy.ts`
- Delete: `packages/cli/src/agy.test.ts`
- Create: `tests/fake-hosts/fake-agy.mjs`

**Interfaces:**
- Produces: `buildAgyTaskArgs(input: AgyTaskOptions): string[]`
- Produces: `class AgyHostAdapter implements HostAdapter`

- [ ] **Step 1: Write failing one-task Agy tests**

Assert arguments contain:

```ts
[
  "--sandbox",
  "--dangerously-skip-permissions",
  "--new-project",
  "--add-dir", workspace,
  "--log-file", logPath,
  "--print",
  prompt
]
```

The prompt may contain task instructions because Agy 1.1.2 does not accept
print-mode prompt stdin, but the process runner must never print argv or include
it in errors. Assert each `runTask()` creates a new process and project, abort
signals terminate it, and the log path is under the marked task-run root.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- packages/hosts/src/agy.test.ts
```

Expected: FAIL because the one-task adapter does not exist.

- [ ] **Step 3: Implement the Agy adapter**

Require Agy 1.1.2 or newer. Reuse `runHostProcess()`, normalize exit outcomes,
and return `usage: null` unless Agy later exposes trustworthy structured usage.
Do not parse or upload the redirected log.

- [ ] **Step 4: Remove the session-wide launcher and verify GREEN**

Run:

```bash
npm run typecheck && npm test -- packages/hosts/src/agy.test.ts packages/cli/src/args.test.ts
```

Expected: PASS and no imports reference `packages/cli/src/agy.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/hosts packages/cli/src/agy.ts packages/cli/src/agy.test.ts tests/fake-hosts/fake-agy.mjs
git commit -m "refactor: run Agy at task boundaries"
```

---

### Task 5: Automatic Partial Checkpoints

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/result.ts`
- Modify: `packages/core/src/repository.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/engine.test.ts`
- Test: `packages/core/src/repository.test.ts`

**Interfaces:**
- Produces: `GenkiEngine.checkpointRun(runId, hostResult): Promise<PartialCheckpoint>`
- Produces: `applyCheckpoint(workspace, checkpoint): Promise<void>`
- Produces: `GenkiEngine.recordHostCompletion(runId, hostResult): Promise<void>`

- [ ] **Step 1: Write failing checkpoint tests**

Create a task, edit one file in its disposable clone, return a
`capacity_unavailable` host result, and assert `checkpointRun()` returns:

```ts
{
  schemaVersion: "1",
  taskId: "checkpoint-task",
  taskRevision: 1,
  attemptId: "attempt-1",
  leaseId: "lease-1",
  leaseGeneration: 1,
  baseCommit,
  patch,
  patchDigest,
  changedFiles: ["value.js"],
  validation: null,
  host: "codex",
  hostOutcome: "capacity_unavailable",
  completedCriteria: [],
  remainingCriteria: ["Regression test passes."],
  createdAt: "2026-07-16T00:00:00.000Z"
}
```

Prove checkpointing asks no consent callback, makes no host call, rejects
out-of-policy patches, and applies cleanly only to the declared base commit.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- packages/core/src/engine.test.ts packages/core/src/repository.test.ts
```

Expected: FAIL because checkpoint APIs do not exist.

- [ ] **Step 3: Persist execution provenance before host launch**

Extend `RunRecord` with task ID/revision, attempt ID, lease ID/generation, host,
and `hostResult: HostRunResult | null`. Persist this record atomically before
starting Agy or Codex so crash recovery can locate the active run without a
model conversation.

- [ ] **Step 4: Implement patch-only checkpoint capture**

Build the patch with existing repository code, enforce task and session limits,
optionally attach already-completed bounded validation, and persist a retained
`checkpoint.json` plus `checkpoint.diff` only in developer test mode. In normal
mode, return the in-memory bundle to the coordinator sink and clean it after
acknowledgement.

- [ ] **Step 5: Implement clean checkpoint application**

Require exact base-commit equality and run:

```bash
git apply --check --whitespace=error-all <checkpoint.diff>
git apply --whitespace=error-all <checkpoint.diff>
```

Invoke Git through argument arrays and stdin, never a shell string. Reject
absolute paths, parent traversal, submodules, binary patches, and symlink escape.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run lint && npm run typecheck && npm test -- packages/core/src/engine.test.ts packages/core/src/repository.test.ts
```

Expected: PASS.

```bash
git add packages/core
git commit -m "feat: capture resumable code checkpoints"
```

---

### Task 6: Coordinator Contracts And Local Adapter

**Files:**
- Create: `packages/coordinator/src/types.ts`
- Create: `packages/coordinator/src/local.ts`
- Create: `packages/coordinator/src/local.test.ts`
- Create: `packages/coordinator/src/index.ts`
- Modify: `packages/core/src/types.ts`

**Interfaces:**
- Produces: `CoordinatorClient.openSession(input): Promise<CoordinatorSession>`
- Produces: `CoordinatorClient.leaseTask(session): Promise<LeasedTask | null>`
- Produces: `CoordinatorClient.heartbeat(input): Promise<LeaseStatus>`
- Produces: `CoordinatorClient.uploadCheckpoint(input): Promise<UploadAck>`
- Produces: `CoordinatorClient.uploadResult(input): Promise<UploadAck>`
- Produces: `CoordinatorClient.closeSession(input): Promise<void>`

- [ ] **Step 1: Write failing local coordinator tests**

Test one active lease at a time, increasing generations after expiry, rejection
of stale generations, idempotent duplicate operation keys, automatic patch and
checkpoint acknowledgement, and close-session rejection of subsequent uploads.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- packages/coordinator/src/local.test.ts
```

Expected: FAIL because the coordinator package does not exist.

- [ ] **Step 3: Define exact coordinator interfaces**

Use:

```ts
export interface UploadAck {
  accepted: boolean;
  operationId: string;
  reason: "accepted" | "duplicate" | "stale_lease" | "session_closed" | "policy_rejected";
}

export interface CoordinatorClient {
  openSession(input: OpenSessionInput): Promise<CoordinatorSession>;
  leaseTask(session: CoordinatorSession): Promise<LeasedTask | null>;
  heartbeat(input: LeaseHeartbeat): Promise<LeaseStatus>;
  uploadCheckpoint(input: CheckpointUpload): Promise<UploadAck>;
  uploadResult(input: ResultUpload): Promise<UploadAck>;
  closeSession(input: CloseSessionInput): Promise<void>;
}
```

Keep Signal calculations out of the client contract. Uploads may include host
usage evidence but never a client-selected Signal value.

- [ ] **Step 4: Implement the local adapter and verify GREEN**

Wrap the existing task directory as deterministic leased tasks. Store accepted
operations in memory for tests and expose inspection methods only on
`LocalCoordinator`, not the public `CoordinatorClient` interface.

Run:

```bash
npm run typecheck && npm test -- packages/coordinator/src/local.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coordinator packages/core/src/types.ts
git commit -m "feat: define Federation One coordinator contract"
```

---

### Task 7: Provider-Neutral Contribution Orchestrator

**Files:**
- Create: `packages/orchestrator/src/session.ts`
- Create: `packages/orchestrator/src/session.test.ts`
- Create: `packages/orchestrator/src/index.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/consent.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `plugins/agy/skills/genki-contribution/SKILL.md`

**Interfaces:**
- Produces: `runContributionSession(input: ContributionSessionInput): Promise<ContributionSessionSummary>`
- Consumes: `HostAdapter`, `CoordinatorClient`, and `GenkiEngine`.

- [ ] **Step 1: Write failing happy-path orchestration test**

With fake coordinator and host, assert the orchestrator:

1. leases one task;
2. prepares the workspace;
3. invokes exactly one host process;
4. runs validation through core;
5. uploads the result automatically;
6. receives acknowledgement;
7. cleans the task run;
8. requests the next task without another consent callback.

- [ ] **Step 2: Write failing checkpoint and stop tests**

Assert a `capacity_unavailable` result with a patch uploads a checkpoint, an
empty-patch attempt uploads only bounded usage evidence, stale-lease rejection
never retries as a new generation, and session stop aborts the host and prevents
new leases. Assert no task title, goal, path, patch, or host output appears in
normal stdout/stderr.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npm test -- packages/orchestrator/src/session.test.ts
```

Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 4: Implement the task-boundary loop**

Use one `AbortController` per active task and a separate session abort signal.
Start a heartbeat timer at one third of the lease duration. Stop the timer before
any terminal upload. Route outcomes as follows:

```text
completed + validation complete -> upload result
non-completed + non-empty patch -> upload checkpoint
non-completed + empty patch -> upload attempt evidence
stale lease -> discard local result and clean
session stop -> bounded checkpoint when policy permits, then close
```

Never resume a host conversation. A predecessor checkpoint is applied before
starting the new host process.

- [ ] **Step 5: Move CLI execution to the orchestrator**

After the existing one-time consent, create the selected host adapter and local
coordinator, then call `runContributionSession()`. Keep generic status and stop
commands. The MCP server remains available for plugin status/stop compatibility
but no longer lets the Agy model own task leasing, validation, finalization, or
cleanup.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run lint && npm run typecheck && npm test -- packages/orchestrator/src/session.test.ts packages/mcp-server/src/server.test.ts packages/cli/src/consent.test.ts
```

Expected: PASS.

```bash
git add packages/orchestrator packages/cli packages/mcp-server plugins/agy
git commit -m "feat: orchestrate Agy and Codex at task boundaries"
```

---

### Task 8: Federation One HTTP Client

**Files:**
- Create: `packages/coordinator/src/http.ts`
- Create: `packages/coordinator/src/http.test.ts`
- Modify: `packages/coordinator/src/index.ts`
- Modify: `packages/cli/src/args.ts`
- Test: `packages/cli/src/args.test.ts`
- Create: `tests/fake-coordinator/server.ts`

**Interfaces:**
- Produces: `class HttpCoordinatorClient implements CoordinatorClient`
- Produces CLI option: `--coordinator <https-url>`

- [ ] **Step 1: Write failing HTTP contract tests**

Run an in-process loopback server and assert these requests:

```text
POST /v1/contribution-sessions
POST /v1/contribution-sessions/{sessionId}/leases
POST /v1/leases/{leaseId}/heartbeat
POST /v1/leases/{leaseId}/checkpoints
POST /v1/leases/{leaseId}/results
POST /v1/contribution-sessions/{sessionId}/close
```

Every mutating request must carry `Idempotency-Key`. The session token is kept
only in memory and sent as `Authorization: Bearer`; it is never written to the
session journal or error output. Reject non-HTTPS coordinator URLs except
loopback URLs used by tests.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- packages/coordinator/src/http.test.ts packages/cli/src/args.test.ts
```

Expected: FAIL because the HTTP client and option do not exist.

- [ ] **Step 3: Implement bounded fetch and strict response parsing**

Use the built-in Node `fetch`, request timeouts via `AbortSignal.timeout()`, a
1 MiB response ceiling, Zod response schemas, and at most three retries with
bounded exponential backoff for network failure and HTTP 429/502/503/504.
Reuse the same idempotency key for retries of one logical operation.

Errors expose only endpoint kind, status code, and normalized failure code. They
must not include authorization values, contributor email, task content, patch,
or response body.

- [ ] **Step 4: Add CLI selection without changing the local default**

`--coordinator local` keeps the current local harness. An HTTPS URL selects
`HttpCoordinatorClient`. Do not make a production URL default in this plan.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm run lint && npm run typecheck && npm test -- packages/coordinator/src/http.test.ts packages/cli/src/args.test.ts
```

Expected: PASS.

```bash
git add packages/coordinator packages/cli tests/fake-coordinator
git commit -m "feat: add Federation One lease client"
```

---

### Task 9: Privacy, Continuation, And Abuse Evidence Integration

**Files:**
- Modify: `tests/local-harness/privacy.integration.test.ts`
- Create: `tests/local-harness/checkpoint-continuation.integration.test.ts`
- Create: `tests/local-harness/host-switch.integration.test.ts`
- Create: `tests/local-harness/attempt-evidence.integration.test.ts`
- Modify: `tests/local-harness/cleanup.integration.test.ts`

**Interfaces:**
- Verifies the complete client behavior; produces no new public API.

- [ ] **Step 1: Add a failing host-secret isolation test**

Seed environment variables, a fake SSH agent socket, a fake cloud credential
file, a sibling repository, and a temporary home secret. Run both fake host
adapters and assert task validation cannot observe any seeded value. Assert the
normal user-facing output contains none of the task, patch, checkpoint, email,
or provider error text.

- [ ] **Step 2: Add a failing checkpoint continuation test**

Have Agy modify one file and exit `capacity_unavailable`. Accept its checkpoint,
expire generation 1, lease generation 2 to Codex, apply the checkpoint to the
same base commit, finish the second change, validate, and accept exactly one
terminal result. Assert the two fresh host invocations share no conversation ID
or transcript.

- [ ] **Step 3: Add a failing attempt-evidence test**

Return Codex usage with an empty patch. Assert the client uploads normalized
usage evidence and no requested Signal amount. Duplicate the operation and
prove the coordinator records one attempt event. Add a contract assertion that
the server-side fixture caps the example award at `normalSignal * 0.01` and at
the configured daily cap.

- [ ] **Step 4: Add model-free cleanup assertions**

Remove Agy, Codex, and network from the test environment after upload failure,
then run expired-session cleanup. Assert all marked task payloads, host logs,
schemas, patches, checkpoints, temporary homes, tokens, and journals disappear
without invoking a host executable.

- [ ] **Step 5: Run integration tests and fix only lifecycle defects**

Run:

```bash
npm test -- tests/local-harness/privacy.integration.test.ts tests/local-harness/checkpoint-continuation.integration.test.ts tests/local-harness/host-switch.integration.test.ts tests/local-harness/attempt-evidence.integration.test.ts tests/local-harness/cleanup.integration.test.ts
```

Expected: PASS with no retained run directory.

- [ ] **Step 6: Commit**

```bash
git add tests/local-harness
git commit -m "test: verify resumable private contribution lifecycle"
```

---

### Task 10: Documentation And Real Local Smoke Tests

**Files:**
- Modify: `README.md`
- Modify: `plugins/agy/plugin.json`
- Modify: `plugins/agy/skills/genki-contribution/SKILL.md`
- Create: `plugins/codex/genki-node/.codex-plugin/plugin.json`
- Create: `plugins/codex/genki-node/skills/genki-contribution/SKILL.md`
- Modify: `package.json`
- Modify: `tests/docs/readme.test.ts`
- Modify: `tests/plugin/agy-plugin.test.ts`
- Create: `tests/plugin/codex-plugin.test.ts`

**Interfaces:**
- Produces installable Agy and Codex plugin metadata.
- Documents exact local-only commands and known safety limits.

- [ ] **Step 1: Scaffold the Codex plugin with the supported generator**

Run:

```bash
python3 /Users/jiangzejia/.codex/skills/.system/plugin-creator/scripts/create_basic_plugin.py \
  genki-node \
  --path plugins/codex \
  --with-skills
```

Expected: `plugins/codex/genki-node/.codex-plugin/plugin.json` exists and its
`name` is exactly `genki-node`. Do not create or modify a personal marketplace
entry; this is a repository-distributed plugin artifact.

- [ ] **Step 2: Write failing package and plugin tests**

Assert npm package files include both plugin directories, the Codex manifest is
valid, no documentation claims private-repository support or production plan
pooling, and both plugin workflows state that one session consent authorizes
automatic patch/checkpoint upload.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npm test -- tests/docs/readme.test.ts tests/plugin/agy-plugin.test.ts tests/plugin/codex-plugin.test.ts
```

Expected: FAIL because Codex plugin packaging metadata, workflow content, and
updated documentation do not exist yet.

- [ ] **Step 4: Document and package both hosts**

Document:

```bash
genki contribute --host agy --task-dir /absolute/path/to/tasks
genki contribute --host codex --task-dir /absolute/path/to/tasks
```

State that the remote coordinator client is experimental, arbitrary remote
repositories remain disabled until outer-sandbox acceptance, personal-plan
availability is not guaranteed, email is optional and unverified, and local
cleanup does not delete provider-side records.

- [ ] **Step 5: Validate the Codex plugin artifact**

Run:

```bash
python3 /Users/jiangzejia/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/codex/genki-node
```

Expected: validation succeeds with no manifest-name, unsupported-field, or
missing-skill errors.

- [ ] **Step 6: Run the full automated gate**

Run:

```bash
npm run check
```

Expected: lint, typecheck, all tests, and production build PASS.

- [ ] **Step 7: Run a real Codex controlled-fixture smoke test**

Use a temporary public-test fixture with one deterministic failing test. Start a
five-minute one-task session with `--host codex`, approve once, and verify:

- Codex edits only the disposable clone;
- the source fixture is unchanged;
- validation passes;
- result upload is acknowledged automatically;
- no per-task or upload prompt appears;
- the Genki run directory is removed;
- no Codex rollout file for the task is created because `--ephemeral` is active.

- [ ] **Step 8: Run a real Agy regression smoke test**

Run the equivalent fixture with `--host agy`. Verify one-task process isolation,
automatic delivery, redirected-log cleanup, and no regression in contributor
status output.

- [ ] **Step 9: Commit**

```bash
git add README.md plugins package.json tests/docs tests/plugin
git commit -m "docs: publish Agy and Codex contribution workflow"
```

---

## Self-Review Checklist

- [ ] Every design requirement maps to a task above.
- [ ] No task implements API, BYOK, enterprise, local-model, Claude, private
  repository, campaign, or cryptocurrency support.
- [ ] Agy and Codex share the same `HostAdapter`, orchestrator, checkpoint,
  validation, upload, and cleanup path.
- [ ] The plan never uses conversation resume for checkpoint continuation.
- [ ] Automatic upload remains bounded by active session authorization.
- [ ] Signal remains server-calculated and no client field can request an award.
- [ ] Remote arbitrary repository execution stays gated on outer-sandbox tests.
- [ ] Provider credentials and raw host logs are absent from protocol types.
- [ ] All changed type names and signatures are consistent across tasks.
- [ ] `npm run check` plus both real controlled-fixture smoke tests form the final
  verification gate.

## Separate Follow-Up Plan

The private `task-server` repository is currently empty. After this client plan
defines and tests the protocol contract, create a separate implementation plan
for the Federation One service covering PostgreSQL persistence, lease
transactions, verification workers, immutable contribution events, Signal
ledger rules, optional encrypted email storage, and the website dashboard feed.
That plan must be reviewed independently before server implementation begins.
