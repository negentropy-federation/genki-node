# Federation One Contribution MVP Design

Date: 2026-07-16
Status: Approved direction; implementation pending

## Summary

The next Genki Node milestone connects the existing local contribution MVP to a
minimal Federation One coordinator and adds Codex beside Agy as a local host.
The coordinator assigns small Federation-One tasks through expiring leases.
Repositories may be public or first-party private (e.g. the Federation OS
codebase); eligibility is not gated on public/open-source status.
The node executes each task inside a disposable, network-denied workspace and
automatically uploads a final patch or a partial checkpoint under the single
authorization granted when the contribution session starts.

Federation One never receives provider credentials and never proxies model
requests. Agy and Codex authenticate and run on the contributor's machine.
Personal-plan adapters are experimental integrations, not production capacity
with an availability promise. API, BYOK, enterprise, local-model, private-repo,
and user campaign support are explicitly outside this milestone.

## Decisions Carried Forward

- Company and product names remain unchanged: Negentropy Federation,
  Federation One, Federation OS, Genki Engine, Genki Node, and Signal.
- A contributor authorizes one bounded contribution session. There is no
  per-task, patch-upload, checkpoint-upload, or final-result confirmation.
- Stopping or expiring a session revokes authorization for future work and
  uploads. An in-flight process is terminated and handled under the bounded
  stop policy.
- Task switching happens at task boundaries, not by transferring model
  conversations.
- Continuation uses code checkpoints. Conversation history, hidden reasoning,
  and chain-of-thought are never transferred between hosts.
- Agy and Codex are the only host adapters in this milestone.
- Claude personal plans are not supported.
- API, BYOK, enterprise channels, and local models are not implemented yet.
- Repository eligibility is governed by the Federation One task source and the
  execution sandbox, not by public/open-source status. First-party private
  repositories (e.g. Federation OS) are eligible in Mode A. (Superseded the
  earlier "public repositories only" rule per user direction, 2026-07-17.)
- Execution is offline by default. A task may declare dependency sources for a
  separate preparation phase, but arbitrary task-time network access is denied.
- Email is optional, private, unverified, and used only as a self-declared
  aggregation/contact field. It is not identity or ownership proof.
- Anonymous contributions cannot later be recovered or merged.
- The public default contributor name and slogan remain placeholders and will
  be chosen separately. No distinguishing suffix is appended.
- Signal is non-transferable contribution accounting, not a token, financial
  asset, ownership claim, or promise of future compensation.
- A valid attempt with model usage but no useful patch may receive attempt
  Signal. Attempt Signal is capped at one percent of the task's normal Signal
  and also has a per-day cap.

## Milestone Scope

### Included

- Agy and Codex local host adapters.
- One consent per bounded contribution session.
- Provider-neutral task execution orchestration.
- Federation One HTTP task leases and lease heartbeats.
- Automatic final patch and partial-checkpoint upload.
- Checkpoint continuation on a fresh node and fresh model conversation.
- Capacity failure classification without relying on a provider quota API.
- Minimal usage evidence when a host reports it.
- Repositories assigned by Federation One, including first-party private
  repositories (e.g. the Federation OS codebase). Eligibility is **not**
  restricted to public or open-source-licensed repositories; execution safety
  rests on the disposable, network-denied sandbox rather than on repository
  visibility.
- Disposable workspaces, restricted process environments, offline execution,
  bounded resource use, and deterministic model-free cleanup.
- A local fake coordinator for end-to-end client tests.

### Excluded

- Provider credentials on Federation One.
- Server-side model calls or remote desktop control.
- Claude personal-plan integration.
- API-key, BYOK, enterprise, or local-model adapters.
- User-created project campaigns or contributed servers.
- Automatic merging into a protected branch.
- Cryptocurrency contributions.
- Public reward promises or financial redemption of Signal.
- A final public contributor-name or slogan default.

**Deferral note (not permanent rejection):** "User-created project campaigns or
contributed servers" and GitHub pull-request / protected-branch merge automation
are excluded *from this milestone only* because they belong to the GitHub
Project Funding Mode (Mode B), recorded as future in
`decisions/0006-github-project-funding-mode.md`.

**Repository scope:** There is no "public repositories / open-source license
only" restriction. Mode A contributors work on Federation-One-assigned repos,
which include first-party **private** repositories such as the Federation OS
codebase — that is the point of Mode A. Repository eligibility is governed by
the Federation One task source and the execution sandbox, not by public/OSS
status. Exposure of first-party private code to a volunteer machine is an
accepted tradeoff mitigated by the disposable, network-denied sandbox, log
redaction, and deterministic cleanup; harden this further at the outer-sandbox
acceptance gate.

## Architecture

```text
Federation One control plane
  project registry
       |
  task queue -> lease service -> verification -> Signal ledger
                   ^                   ^              ^
                   |                   |              |
             lease/heartbeat      patch/checkpoint  accepted event
                   |                   |              |
Genki Node         |                   |              |
  session consent -> coordinator client -> task orchestrator
                                              |
                                    disposable workspace
                                              |
                                     host adapter boundary
                                      /                 \
                               Agy adapter          Codex adapter
```

The control plane decides what work exists, which node owns the current lease,
whether a submission is accepted, and how much Signal is recorded. The node
decides whether a task fits the already-authorized local policy and enforces the
local execution boundary. Host adapters only transform a prepared task into a
working-tree change and bounded execution evidence.

## Trust Boundaries

### Federation One

Federation One is trusted to assign tasks and receive authorized result data.
It is not trusted with provider credentials or access to unrelated local data.
It receives only protocol records, patches, checkpoint summaries, bounded test
evidence, and optional contributor fields.

### Project Repository

Repository contents, build files, tests, instructions, and dependencies are
untrusted. Merely being public or open source does not make code safe to run.
Repository code is never executed outside the Genki sandbox.

### Host Agent

Agy and Codex are allowed to edit only the disposable workspace. They are not
allowed to request new user approvals during an authorized session. Any action
outside the policy fails closed. Their authentication remains locally managed
by the provider client.

### Contributor Machine

The contributor or machine administrator can inspect task content. Genki Node
does not promise confidentiality from the machine owner. It promises bounded
access to unrelated host data and deterministic deletion of Genki-owned task
artifacts after delivery or expiry.

## Contribution Session

The contributor sees and accepts a policy envelope before any remote task is
leased. The consent summary includes:

- Host: Agy or Codex.
- Session duration and absolute expiration.
- Maximum tasks, total runtime, and per-task runtime.
- Maximum changed files and patch bytes.
- Repository scope: Federation-One-assigned repos, public or first-party
  private (no public/open-source-only restriction).
- Allowed validation executables.
- Default-off task network access.
- Automatic patch and checkpoint upload.
- Optional contributor name, slogan, and email behavior.
- The local paths Genki owns and will remove.
- A persistent stop control.

The policy digest is bound to the session. A server task that exceeds the
accepted envelope is rejected without asking the contributor for more access.

## Contributor Fields

The session may include:

```ts
interface ContributorClaim {
  displayName: string | null;
  slogan: string | null;
  email: string | null;
}
```

Null display name and slogan are rendered with future project-wide defaults.
The defaults do not include a short identifier. Email is encrypted at rest by
the coordinator and is never returned in public APIs. A normalized email hash
may be used to aggregate records, while the encrypted original is retained only
for private contact. Because email is unverified, the product must label this
as self-declared metadata and cannot use it for authentication, authorization,
recovery, or reward ownership.

Anonymous sessions omit email. Their contributions remain separate internal
records even if the public page renders all of them under the same default name.
No endpoint converts an anonymous historical record into an email-associated
record.

## Task Shape

Federation One issues immutable task revisions. A representative client shape
is:

```ts
interface LeasedTask {
  schemaVersion: "2";
  taskId: string;
  revision: number;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  project: {
    projectId: string;
    repositoryUrl: string;
    licenseSpdx: string;
    baseCommit: string;
  };
  goal: string;
  acceptanceCriteria: string[];
  validation: Array<{
    argv: [string, ...string[]];
    timeoutSeconds: number;
  }>;
  policy: {
    maxRuntimeSeconds: number;
    maxChangedFiles: number;
    maxPatchBytes: number;
    executionNetwork: "none";
    dependencyDomains: string[];
  };
  predecessorCheckpoint: CheckpointReference | null;
}
```

The initial server must enforce a small task size: one primary goal, normally no
more than five expected files, deterministic acceptance criteria, and a target
execution time of five to twenty minutes. Larger work is split before dispatch.

## Lease Protocol

1. After local consent, the node opens a coordinator session and receives a
   short-lived session token. This token authorizes only task lease and result
   operations for that contribution session.
2. The node requests one task. Federation One returns a task plus a lease ID,
   monotonically increasing lease generation, and expiration time.
3. The node sends heartbeats while preparing or executing the task.
4. A completed result or checkpoint includes the lease ID and generation.
5. Federation One accepts at most one terminal result for the active generation.
   Late submissions from an expired generation are stored as rejected audit
   events and never applied or scored.
6. When a lease expires, the task may be assigned to another node. The new node
   starts from the same base commit plus the last accepted checkpoint, if any.

All mutating requests carry an idempotency key derived from session, task,
attempt, lease generation, and operation kind. Retries cannot create duplicate
checkpoints, results, or Signal events.

## Task Execution Lifecycle

```text
leased
  -> acquired
  -> prepared
  -> executing
  -> validating
  -> uploading_result
  -> verified | rejected

executing
  -> checkpointing
  -> uploading_checkpoint
  -> capacity_unavailable | interrupted | lease_lost
```

The local orchestrator, not the model conversation, owns this lifecycle. Each
task starts a fresh Agy or Codex process and a fresh model conversation. The host
adapter exits after producing a working-tree change or a classified failure.

## Checkpoints And Continuation

A checkpoint is code state, not conversational state. It contains:

```ts
interface PartialCheckpoint {
  schemaVersion: "1";
  taskId: string;
  taskRevision: number;
  attemptId: string;
  leaseId: string;
  leaseGeneration: number;
  baseCommit: string;
  patch: string;
  patchDigest: string;
  changedFiles: string[];
  validation: BoundedValidationSummary | null;
  host: "agy" | "codex";
  hostOutcome: HostOutcomeCode;
  completedCriteria: string[];
  remainingCriteria: string[];
  createdAt: string;
}
```

The node captures a checkpoint automatically when:

- A host process exits before normal completion.
- Several model requests fail or time out and capacity becomes unavailable.
- The session is stopped and a bounded final checkpoint can be captured before
  the stop deadline.
- The lease approaches expiry.
- The task runtime limit is reached.

Checkpoint creation and upload do not call a model. Completed and remaining
criteria come from a small optional host final schema when available; otherwise
they are empty and the patch remains authoritative. No full prompt, model
output, chain-of-thought, terminal transcript, or host conversation ID is
uploaded.

## Host Adapter Contract

```ts
type HostName = "agy" | "codex";

interface HostRunInput {
  sessionId: string;
  taskId: string;
  attemptId: string;
  workspace: string;
  instructions: string;
  model: string | null;
  timeoutSeconds: number;
  abortSignal: AbortSignal;
}

interface HostRunResult {
  host: HostName;
  outcome: HostOutcomeCode;
  exitCode: number | null;
  usage: HostUsage | null;
  completedCriteria: string[];
  remainingCriteria: string[];
}

interface HostAdapter {
  readonly name: HostName;
  checkAvailability(): Promise<HostAvailability>;
  runTask(input: HostRunInput): Promise<HostRunResult>;
}
```

Host adapters do not clone repositories, run acceptance validation, build
patches, upload results, calculate Signal, or clean storage. Those operations
remain provider-neutral.

### Codex

The Codex adapter uses one non-interactive `codex exec` process per task with:

- `--ephemeral` so rollout/session files are not persisted.
- `--sandbox workspace-write` and approval policy `never` so an attempted
  escalation fails instead of prompting the contributor.
- Network access explicitly disabled.
- `--ignore-user-config` to avoid unrelated user MCP servers and customizations;
  saved authentication remains provider-managed.
- `--ignore-rules` to avoid unrelated personal exec-policy behavior.
- `--json` for bounded machine-readable lifecycle and usage events.
- `--output-schema` for completed/remaining acceptance-criteria summaries.
- `-C <workspace>` with no additional writable directory.

The task prompt is sent over stdin rather than placed in process arguments.
JSONL is parsed in memory. Raw events and the final model message are discarded
after extracting outcome, usage, and the bounded structured summary.

### Agy

The Agy adapter moves to one non-interactive Agy process per task. It uses a new
project, the Genki sandbox, the disposable workspace, a Genki-owned log path,
and the already-authorized no-per-task-prompt mode. The redirected log is
deleted by deterministic cleanup. The existing Agy plugin remains the install
and discovery surface, but task lifecycle ownership moves to the Genki
orchestrator so Agy and Codex behave consistently.

## Sandbox And Network

Codex or Agy's built-in sandbox is defense in depth, not the entire Genki trust
boundary. Before remote community tasks are enabled, Genki must provide an
outer execution sandbox with these properties:

- Only the disposable workspace and run-specific temporary directory are
  visible to task commands.
- User home directories, other repositories, browser data, SSH agents, cloud
  credentials, and unrelated environment variables are unavailable.
- CPU, memory, disk, process count, and wall time are bounded.
- Task-time network is denied.
- Loopback, LAN ranges, cloud metadata endpoints, and Unix sockets outside the
  run are denied.
- Dependency preparation, when later enabled, runs separately through an
  allowlist proxy and produces a read-only dependency cache for execution.

The local development milestone may use controlled fixture repositories before
the outer sandbox is complete. It must not claim that arbitrary remote
repositories are safe until the sandbox acceptance tests pass.

## Capacity Classification

No host-independent quota API is required. The adapter classifies observable
outcomes:

- `completed`: host returned normally.
- `quota_exhausted`: host emitted an explicit provider quota or usage-limit
  signal.
- `capacity_unavailable`: repeated transient failures or timeouts crossed the
  configured threshold without an explicit quota signal.
- `authentication_failed`: local provider login is missing or expired.
- `host_failed`: local CLI or host process failed.
- `interrupted`: session stop, process signal, or local shutdown.
- `timed_out`: task wall-time limit expired.

Several failures may trigger `capacity_unavailable`, but the node never reports
that as confirmed quota exhaustion. The raw provider error is not uploaded;
only the normalized code and bounded counters are sent.

## Result Verification

The node uploads a candidate result containing the patch, base commit, task and
lease provenance, bounded local validation summary, host outcome, and optional
usage evidence. Federation One then:

1. Rejects stale or duplicate lease generations.
2. Reconstructs a clean checkout at the declared base commit.
3. Applies the patch without fuzz or out-of-tree paths.
4. Re-runs server-owned validation in a trusted verification sandbox.
5. Enforces changed-file, patch-size, license, and project policies.
6. Records an immutable accepted or rejected contribution event.
7. Emits Signal ledger entries only from verified server events.

The node never decides its own Signal award.

## Signal Accounting

Signal has at least two internal event classes:

- `work_signal`: accepted useful code or an accepted checkpoint later shown to
  contribute to completed work.
- `attempt_signal`: verified model usage with no useful patch.

Attempt Signal rules:

- The attempt must map to a valid server task lease.
- At least one host model invocation must have started.
- The event is idempotent per task attempt.
- Client-reported token counts are evidence, not trusted accounting truth.
- The award is no more than one percent of the task's normal Signal.
- A contributor-level daily cap applies.
- Repeated intentional failures, duplicate clients, or impossible telemetry may
  be rejected by abuse controls.

A checkpoint that is later incorporated into an accepted result can receive
retroactive work Signal. Token consumption alone never receives work Signal.

## Local Data And Cleanup

Genki persists only the minimum state needed to recover the active session and
retry authorized uploads. Normal contributor output contains aggregate counts
and normalized outcome codes, not task instructions, repository paths, patches,
or command output.

After a result or checkpoint upload is acknowledged, deterministic local code
removes the clone, task payload, patch copy, bounded validation output, host
output, temporary home, and Genki-owned log. If delivery fails, encrypted or
permission-restricted retry material may remain only until the session's local
retry deadline. Session stop revokes new uploads; a checkpoint already captured
under the stop deadline may complete only when the stop policy explicitly
allows that final bounded operation.

Cleanup never invokes a model and never mutates undocumented Agy or Codex data
stores. Codex runs use `--ephemeral`; Agy logs are redirected into the owned run
directory. The design does not claim deletion of provider records, OS logs,
terminal scrollback, backups, snapshots, or data copied by the machine owner.

## Delivery Phases

### Phase 1: Provider-Neutral Local Orchestrator

- Refactor host selection from Agy-only to `agy | codex`.
- Run one fresh host process per task.
- Add automatic partial checkpoint capture.
- Keep the current local task source and retained test sink.
- Validate both adapters against controlled local fixtures.

### Phase 2: Federation Protocol Client

- Add coordinator sessions, task leases, heartbeats, idempotent checkpoint and
  result upload, and a local fake coordinator.
- Add remote repository acquisition with immutable base commits, first-party
  Federation repositories first (public or private).
- Keep arbitrary third-party remote execution disabled until Phase 3 passes.

### Phase 3: Outer Sandbox And Remote Pilot

- Enforce filesystem, process, resource, and default-deny network isolation.
- Run malicious-repository and credential-exfiltration acceptance tests.
- Pilot only Negentropy Federation controlled repositories (public or
  first-party private); arbitrary third-party repositories stay disabled.

### Phase 4: Trusted Verification And Signal

- Deploy the private Federation One task and verification service.
- Record work and attempt Signal from immutable server-side events.
- Publish a mock-to-live contribution dashboard feed without exposing email.

User project campaigns (Mode B), arbitrary third-party repositories, additional
provider channels, cryptocurrency contributions, and Federation OS development
at scale require separate approved designs. (First-party private repositories
are in scope for Mode A and no longer deferred.)

## Acceptance Criteria

- A user can authorize a bounded Agy or Codex contribution session once.
- Neither adapter asks for per-task or upload confirmation.
- Each task runs in a fresh process and fresh model conversation.
- Codex leaves no session rollout files for the task.
- Agy and Codex produce the same provider-neutral task outcome contract.
- A host failure with a non-empty patch creates and automatically uploads a
  checkpoint without a model call.
- A new simulated node can apply the checkpoint to the original base commit and
  continue the task.
- Stale lease generations cannot overwrite accepted work or earn Signal.
- Task execution has no arbitrary network access.
- Task commands cannot read seeded host secrets in sandbox acceptance tests.
- Anonymous contributions remain unrecoverable and optional email is never
  exposed publicly or treated as verified identity.
- Attempt Signal cannot exceed one percent of normal task Signal and is subject
  to a daily cap.
- Normal cleanup succeeds when the provider is unavailable or quota is empty.

