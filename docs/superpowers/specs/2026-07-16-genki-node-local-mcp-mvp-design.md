# Genki Node Local MCP MVP Design

Date: 2026-07-16
Status: **Phase 1 — DELIVERED, SUPERSEDED FOR SCOPE.** Implemented and locally
verified. This is the narrow first milestone only: local-only, single host
(Agy), MCP-plugin integration (local `stdio` MCP server + Agy plugin + seven
MCP tools), **no Codex, no checkpoints, no Federation One**. The current
canonical scope is defined in `2026-07-16-federation-one-contribution-mvp-design.md`
and implemented via `2026-07-16-genki-node-codex-checkpoint-mvp.md`, which add
Codex beside Agy, **replace the Agy-via-MCP-plugin integration with a unified
host-adapter subprocess model** (one fresh Agy or Codex process per task), add
local checkpoints/continuation, and connect Federation One (HTTP leases,
automatic patch + checkpoint upload, coordinator/orchestrator, Signal
accounting). Do NOT read this file's Non-Goals as current — they exclude Codex,
checkpoints, and Federation One, all of which are now in scope.

## Summary

Genki Node MVP is a local contribution agent that runs coding tasks through Agy in disposable repository clones. A contributor grants one bounded authorization when starting a contribution session. Tasks inside that policy envelope run without per-task prompts, their content is not proactively shown in the user interface, results are delivered without a final approval prompt, and deterministic local code removes Genki-controlled task artifacts afterward.

The integration boundary is a local Model Context Protocol (MCP) server. Agy starts the server over `stdio`; the server does not listen on a TCP port or run as a background daemon. Codex and Claude Code integrations can later reuse the same MCP server and core packages.

This MVP is local. It reads tasks from a local test queue and delivers results to a local test sink. It does not connect to Federation One, calculate Signal, or collect provider credentials.

## Privacy Boundary

Genki Node can keep task details out of its normal status UI and delete files it controls. It cannot make task content technically inaccessible to the owner or administrator of the machine executing that task. A device owner can inspect processes, temporary files, memory, host-agent records, or operating-system activity.

The product promise for the MVP is therefore:

- Task content is hidden by default, not cryptographically hidden from the device owner.
- Genki Node does not intentionally render task instructions, repository content, patches, or command output in its contributor status UI.
- Genki-owned task payloads, clones, patches, validation output, temporary homes, journals, and redirected Agy CLI logs are removed by deterministic cleanup code.
- Genki Node does not claim to delete Agy's global conversation databases, Agy history, provider-side records, terminal scrollback, backups, filesystem snapshots, or operating-system logs.

## Goals

- Install and validate Genki Node as a real Agy plugin.
- Start a time- and resource-bounded contribution session with one explicit user authorization.
- Process local coding tasks through Agy without per-task or final-result confirmations.
- Keep task content out of the normal contributor-facing status flow.
- Keep source repositories and their Git metadata unchanged.
- Execute only predeclared validation commands through the Genki Node policy layer.
- Deliver structured results automatically, then purge Genki-controlled task artifacts without a model call.
- Establish a host-neutral MCP and core architecture that can later support Codex and Claude Code.

## Non-Goals

- Federation One connectivity, remote dispatch, or remote result upload.
- Signal calculation or contribution accounting.
- GitHub Issues, pull requests, commits, pushes, or automatic patch application.
- Docker or operating-system-grade sandboxing.
- Private repositories, submodules, production deployment, or cloud actions.
- Direct provider API integrations, API-key storage, subscription pooling, or credential forwarding.
- A long-running TCP service, web interface, or desktop tray interface.
- Codex and Claude Code adapters in the MVP release.
- Guaranteed secrecy from the machine owner.
- Deletion of logs or records owned by Agy, a model provider, the terminal, the operating system, backup software, or filesystem snapshots.

## Architecture

The repository is a TypeScript monorepo with five runtime boundaries:

1. **Core** owns session policy, task validation, run state, repository preparation, ephemeral journals, result construction, and cleanup. It does not import Agy- or MCP-specific code.
2. **MCP Server** exposes core operations as local `stdio` tools. It owns no model credentials and performs no remote requests.
3. **CLI** starts and stops contribution sessions, launches Agy, reports generic session status, and provides a model-free cleanup command.
4. **Agy Plugin** contains the Agy manifest, MCP configuration, and contribution workflow skill. It is a thin host adapter.
5. **Local Test Harness** supplies local tasks and acknowledges local results so the complete lifecycle can be tested without Federation One.

Planned repository structure:

```text
genki-node/
  packages/
    core/
    mcp-server/
    cli/
  plugins/
    agy/
  examples/
    tasks/
  tests/
    fixtures/
    local-harness/
  docs/
    superpowers/
      specs/
      plans/
```

The MCP server is launched on demand over `stdio`. There is no port selection, local network authentication, PID file, or independently running daemon in the MVP.

## Contribution Session Policy

The contributor authorizes a session policy, not individual task content. The user-visible authorization summary includes:

- Session duration and absolute expiry time.
- Maximum number of tasks.
- Maximum total runtime and per-task runtime.
- Host and model selection.
- Repository class: local public-test fixtures only in the MVP.
- Allowed validation executable names.
- Maximum changed files and patch bytes per task.
- A statement that task details are hidden by default but technically inspectable by the machine owner.
- A statement that successful and failed results are delivered automatically.
- The paths Genki Node controls and will clean.
- A persistent pause/stop control that revokes authorization immediately.

The MVP CLI accepts explicit session limits. A representative launch is:

```bash
genki contribute \
  --host agy \
  --task-dir /absolute/path/to/local-task-queue \
  --duration 8h \
  --max-tasks 10 \
  --max-total-runtime 2h
```

No task can start after the session expires, reaches a limit, or is revoked. A task already running when authorization is revoked is terminated before cleanup.

## Local Task Format

Tasks are versioned JSON files consumed internally by the plugin and test harness. They are not rendered in the normal contributor UI.

```json
{
  "schemaVersion": "1",
  "id": "local-smoke-001",
  "title": "Fix the failing parser test",
  "repository": {
    "path": "/absolute/path/to/repository",
    "baseRef": "HEAD"
  },
  "instructions": "Fix the parser without changing its public API.",
  "validation": [
    {
      "argv": ["npm", "test"],
      "timeoutSeconds": 300
    }
  ],
  "policy": {
    "maxRuntimeSeconds": 900,
    "maxChangedFiles": 20,
    "maxPatchBytes": 200000
  }
}
```

Validation rules:

- `schemaVersion` must equal `"1"`.
- `id` must contain only ASCII letters, digits, dots, underscores, and hyphens, and be no longer than 80 characters.
- `repository.path` must be absolute, local, and point to a clean Git repository.
- `baseRef` must resolve to a commit in that repository.
- Repositories containing configured Git submodules are rejected.
- Absolute symlinks and symlinks whose normalized target escapes the repository are rejected.
- `instructions` must be non-empty and no longer than 20,000 UTF-8 bytes.
- Validation commands are argument arrays. Shell strings, redirection, pipes, command substitution, and inline environment assignments are rejected.
- Every executable must be allowed by both the session policy and the task policy.
- Task limits must fit entirely inside the remaining session limits.

The core resolves `baseRef` to a commit and computes a SHA-256 task digest over the normalized task and resolved commit. The task digest is used for result provenance but is not displayed in the normal status UI.

## State Machines

The session state machine is:

```text
configured
  -> awaiting_session_consent
  -> active
  -> draining
  -> closed | expired | revoked
```

The task state machine inside an active session is:

```text
queued
  -> policy_checked
  -> prepared
  -> executing
  -> validating
  -> finalizing
  -> delivered
  -> purged

Any active task state may become failed or frozen, then purged.
```

There is no `awaiting_execution_consent` per task and no `awaiting_result_consent`. The single session authorization permits every task that fits the displayed session policy. Policy mismatches are rejected automatically rather than escalated through another prompt.

## MCP Tool Contract

The MVP exposes seven host-neutral tools.

### `genki_describe_session`

Input: proposed session limits and local task-queue path.

Behavior: validates limits and returns the user-visible policy summary. It does not read or reveal queued task content and does not start a session.

### `genki_activate_session`

Input: policy digest and an explicit session-consent assertion from the host.

Behavior: verifies the digest, records the one authorization event, activates the session, and returns only generic status fields.

The MCP server can record that the host asserted user consent, but it cannot cryptographically prove a human gave that consent. The Agy skill must not call this tool until the user has affirmatively accepted the policy summary.

### `genki_prepare_next_task`

Input: active session identifier.

Behavior: reads the next local task, validates it against the session policy, creates a disposable local clone, and returns the workspace and task instructions to the host agent. The plugin does not echo this payload into its contributor-facing response.

### `genki_run_validation`

Input: task-run identifier.

Behavior: executes the exact validation argument arrays from the task in order, with individual, task, and session time limits. It does not accept arbitrary commands from the host.

### `genki_finalize_and_deliver`

Input: task-run identifier.

Behavior: builds the patch and validation result, enforces output limits, delivers the result to the configured sink, records the sink acknowledgement, and immediately invokes deterministic task cleanup. It asks no user question.

A task with failed validation is delivered with status `failed`, never as a successful contribution. A policy violation is delivered as bounded failure metadata without task content.

### `genki_session_status`

Input: session identifier.

Behavior: returns generic counters, elapsed time, remaining limits, active/paused state, and last outcome code. It does not return task titles, instructions, repository paths, patches, or command output.

### `genki_stop_session`

Input: session identifier.

Behavior: revokes authorization, terminates an active task, attempts final delivery of bounded failure metadata, runs deterministic cleanup, and closes the session. It does not call a model.

## Agy Experience

The Agy plugin supplies:

- A valid Agy plugin manifest.
- An MCP configuration that starts the local Genki MCP server over `stdio`.
- A contribution workflow skill that requests session authorization once.
- Instructions that keep task payloads out of ordinary contributor-facing responses.
- Instructions that process policy-compliant tasks without follow-up confirmation.

The CLI creates an ephemeral session root, starts Agy with `--sandbox`, `--new-project`, and `--log-file <session-root>/agy.log`, and adds only the session root to the Agy workspace. After authorization, each disposable clone is created inside that already-authorized root.

The normal visible flow is limited to:

```text
Contribution session ready: 8 hours, up to 10 tasks.
Start contribution mode? [y/N]

Contribution mode active. Press Ctrl-C to stop.
Completed: 3  Failed: 1  Remaining: 6
Contribution session closed. Local Genki artifacts cleared.
```

Task titles, instructions, repository paths, patches, and test output are not proactively displayed. The machine owner can still inspect them using operating-system access, and the design does not claim otherwise.

Agy remains responsible for authentication, model communication, and its own data stores. Genki Node does not receive Agy credentials, session material, cookies, refresh tokens, or provider API keys.

## Disposable Workspace

For each accepted task, Genki Node clones the source repository using local transport with hardlinks disabled and checks out the resolved commit in detached state. The clone has independent Git metadata.

The source repository must be clean. Genki Node never commits, pushes, changes source refs, or applies the generated patch back to it.

The clone, task payload, empty temporary home, validation output, patch, and transient journal all live under the marked Genki session root. They are eligible for deterministic deletion as a single bounded tree after result delivery or failure handling.

## Process And Environment Policy

Validation commands use direct process spawning with `shell: false`.

The child environment is built from an allowlist. It contains only the executable search path, locale values, terminal type when needed, a run-specific temporary directory, a run-specific empty `HOME`, and non-secret Genki identifiers.

Provider keys, cloud credentials, Git credential variables, SSH agent variables, proxy credential variables, and arbitrary parent environment values are not inherited. Environment values are never written to Genki logs.

The MCP server performs no remote requests. Agy model communication remains under Agy's local account controls. Without Docker or an operating-system network sandbox, the MVP cannot technically guarantee that every host process is offline. Local test tasks must rely only on tracked files and machine-installed tools; dependency installation is outside MVP validation.

## Ephemeral Records And Result Delivery

Genki Node uses a minimal crash-recovery journal while a task is active. It contains identifiers, policy and task digests, state transitions, timestamps, executable names, exit codes, bounded outcome codes, and cleanup status. It does not contain full task instructions, source files, patches, full model conversations, environment values, or unbounded command output.

Command output is held in a bounded in-memory ring buffer. If process recovery requires a temporary spill file, that file remains under the marked session root and is deleted by the same cleanup routine.

The local MVP sink is a test harness that acknowledges an in-memory or temporary result bundle. Automated tests may enable an explicit developer-only `--retain-until-verified` mode so assertions can inspect the bundle before invoking the same cleanup command. Contributor mode does not enable retention.

Federation One will later replace the local test sink. Cleanup must occur only after a sink acknowledgement or after the session's privacy-first retry window expires. If delivery repeatedly fails, the result may remain only inside the marked session root until session expiry, after which it is deleted even if delivery was unsuccessful.

## Deterministic Cleanup

Cleanup is ordinary local code and never invokes Agy, Codex, Claude Code, an API, or another model. It works when the contributor has no model quota remaining.

The CLI exposes:

```bash
genki cleanup --session <session-id>
genki cleanup --all-expired
```

The same cleanup library runs automatically:

- After a result sink acknowledges delivery.
- After a task fails or is frozen and bounded failure delivery completes.
- When a session is stopped, expires, or closes normally.
- On handled `SIGINT` and `SIGTERM` signals.
- During the next startup to recover from crashes or power loss.

Cleanup deletes only a directory that is under the configured Genki state root, contains a valid Genki ownership marker, has a matching session identifier, and is not a symlink. These checks prevent task-controlled paths from turning cleanup into arbitrary deletion.

Cleanup removes:

- Task JSON copies and transient task payloads.
- Disposable repository clones and temporary Git metadata.
- Temporary homes and process output spill files.
- Patches, validation details, and transient result bundles after delivery acknowledgement.
- Genki task journals after terminal cleanup state is recorded.
- The Agy CLI log explicitly redirected into the Genki session root.

Default contributor mode retains no per-task local history after cleanup. The CLI may show an in-memory aggregate count before exit, but it does not persist that count by default.

Cleanup does not edit or delete Agy's global conversation databases, global history, `brain` directories, provider records, terminal history, operating-system logs, backups, or snapshots. The installed Agy CLI exposes `--log-file`, which Genki redirects and cleans, but it does not expose a supported command for removing all other Agy-owned session records. Genki Node will not mutate those stores using undocumented database operations.

## Error Handling

- Invalid session policy: return structured errors and create no active session.
- Session consent denied: remove the empty launcher root and start no task.
- Invalid, dirty, unsupported, or out-of-policy task: reject it automatically, deliver a bounded outcome code, and continue if session limits permit.
- Agy cancellation, timeout, session expiry, or user stop: terminate active work, deliver bounded failure metadata when possible, and run cleanup without a model call.
- Validation failure: deliver a failed result automatically and clean after acknowledgement.
- Runtime, file-count, patch-size, digest, or path violation: freeze the task, deliver bounded failure metadata, and clean.
- Result-delivery failure: retry only inside the active session and privacy window; purge at expiry even if delivery never succeeds.
- MCP crash or power loss: preserve only the minimal journal under the marked session root; recover and clean on next startup.
- Cleanup failure: report the retained Genki path and retry on next startup without claiming cleanup succeeded.

## Testing Strategy

### Unit Tests

- Accept valid session policies and reject invalid duration, task, runtime, executable, and output limits.
- Require exactly one consent transition before a session becomes active.
- Reject tasks that exceed the remaining session policy without requesting more consent.
- Accept valid version-1 tasks and reject malformed or oversized fields.
- Reject relative repository paths, dirty repositories, submodules, and escaping symlinks.
- Enforce valid session and task state transitions.
- Spawn validation commands without a shell and with the environment allowlist.
- Remove seeded secrets from child environments, journals, result serialization, and cleanup reports.
- Ensure generic status objects contain no task title, instructions, repository path, patch, or command output.
- Validate cleanup roots and reject symlink, marker, identifier, and traversal attacks.
- Run cleanup with the Agy executable unavailable to prove it consumes no model quota.

### Integration Tests

- Authorize one session, process multiple local tasks, and observe no additional consent calls.
- Clone temporary Git fixtures, modify only clones, validate, deliver, and verify source repositories remain unchanged.
- Exercise validation failure, timeout, policy freeze, digest mismatch, delivery retry, session expiry, user stop, and crash recovery.
- Start the MCP server over `stdio` and exercise all seven tools through an MCP client.
- Seed distinctive task text and secret values, run cleanup, and confirm neither remains anywhere under the Genki state root.
- Redirect an Agy-style log into the session root and confirm cleanup removes it without touching files outside that root.

### Agy Smoke Test

- Validate, install, enable, uninstall, and reinstall the Agy plugin.
- Launch contribution mode through `genki contribute`.
- Review and accept one session policy.
- Let a real Agy model complete at least one bounded local fixture task without per-task or result prompts.
- Observe only generic contributor status in the normal flow.
- Verify the delivered patch and report through developer-only test-harness retention.
- Invoke model-free cleanup and confirm the original fixture is unchanged and Genki-controlled task artifacts are gone.
- Record separately whether the current Agy version creates host-owned conversation artifacts, without claiming Genki removed them.

## Acceptance Criteria

The MVP is complete when all of the following are true:

- The public repository contains reproducible build, test, lint, plugin-install, session-start, stop, and cleanup instructions.
- `agy plugin validate` succeeds for the packaged plugin.
- CLI and Agy flows use the same MCP server and core implementation.
- A user authorizes one bounded session and receives no task-level or result-level approval prompts.
- Normal contributor status reveals no task title, instructions, repository path, patch, or command output.
- A real Agy model completes a local fixture task and automatically delivers a passing result.
- Source repositories and their Git metadata remain unchanged.
- A seeded secret and distinctive task string cannot be found under the Genki state root after cleanup.
- Cleanup succeeds with no Agy process, provider access, or remaining model quota.
- Unit, integration, MCP protocol, cleanup, and Agy smoke tests pass.
- Documentation states that Agy-owned and system-owned records are outside Genki's deletion guarantee.
- No Federation One, Signal, GitHub, provider-key storage, remote telemetry, Docker, or additional-host behavior is present.

## Known Security Limitations

The no-Docker choice is not a strong sandbox. Agy sandbox mode, disposable clones, direct command spawning, a clean environment, exact validation commands, limits, and deterministic cleanup reduce accidental harm and local residue; they do not protect against a malicious host process, operating-system compromise, or every repository-level exploit.

The MCP server controls its own subprocesses but cannot prevent a compromised host agent from attempting to use other tools exposed by that host. Hiding task content in the UI is a product behavior, not a security boundary.

The first post-MVP hardening milestone is container-backed execution with explicit filesystem mounts and network policy. Public claims must describe the MVP as controlled local isolation with best-effort Genki artifact cleanup, not secure arbitrary-code execution or guaranteed forensic erasure.

## Future Compatibility

Codex and Claude Code integrations will each provide a host manifest/configuration and workflow skill that map to the same session and task MCP tools. They must not fork session policy, task semantics, run states, cleanup guarantees, or result formats.

Federation One connectivity will be added behind a separate task-source and result-sink boundary. Cleanup will wait for an authenticated delivery acknowledgement, then remove the local task artifacts. Signal accounting remains outside Genki Node's local execution core and is not part of this MVP.
