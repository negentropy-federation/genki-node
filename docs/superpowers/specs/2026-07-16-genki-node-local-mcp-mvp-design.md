# Genki Node Local MCP MVP Design

Date: 2026-07-16
Status: Approved in conversation; awaiting final written-spec review

## Summary

Genki Node MVP is a local contribution agent that runs a user-authored coding task through Agy, inside a disposable repository clone, and produces a reviewed patch and structured local result. It is packaged as an Agy plugin for the first real-world test while keeping its task, policy, workspace, audit, and result logic independent of Agy.

The integration boundary is a local Model Context Protocol (MCP) server. Agy starts the server over `stdio`; the server does not listen on a TCP port or run as a background daemon. Codex and Claude Code integrations can later reuse the same MCP server and core packages.

This MVP is deliberately local. It does not connect to Federation One, calculate Signal, pull remote tasks, submit results over a network, or collect provider credentials.

## Goals

- Install and validate Genki Node as a real Agy plugin.
- Run one local coding task against a clean local Git repository using Agy.
- Require explicit user confirmation before execution and before saving a result.
- Keep the source repository and its Git metadata unchanged.
- Execute only predeclared validation commands through the Genki Node policy layer.
- Produce a patch, test report, and minimal audit record without provider credentials or full model transcripts.
- Establish a host-neutral MCP and core architecture that can later support Codex and Claude Code.

## Non-Goals

- Federation One connectivity or remote task dispatch.
- Signal calculation, contribution submission, or public contribution accounting.
- GitHub Issues, pull requests, commits, pushes, or automatic patch application.
- Docker or operating-system-grade sandboxing.
- Private repositories, submodules, production deployment, or cloud actions.
- Direct provider API integrations, API-key storage, subscription pooling, or credential forwarding.
- A long-running local daemon, TCP listener, web interface, or desktop tray interface.
- Codex and Claude Code adapters in the MVP release.

## Architecture

The repository is a TypeScript monorepo with four runtime boundaries:

1. **Core** owns task validation, run state, policy decisions, repository preparation, audit events, and result construction. It does not import Agy- or MCP-specific code.
2. **MCP Server** exposes core operations as local `stdio` tools. It owns no model credentials and performs no remote requests.
3. **CLI** provides local inspection, run launch, run listing, and cleanup. The primary command `genki run --host agy <task-file>` launches Agy with sandbox mode and the task context.
4. **Agy Plugin** contains the Agy manifest, MCP configuration, and Genki workflow skill. It is a thin adapter and contains no contribution-accounting or workspace logic.

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
  docs/
    superpowers/
      specs/
      plans/
```

The MCP server is launched on demand by the host through `stdio`. There is no port selection, local network authentication, PID file, or daemon lifecycle in the MVP.

## Local Task Format

Tasks are versioned JSON files. The MVP schema is:

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
- Each validation command is an argument array. Shell strings, redirection, pipes, command substitution, and inline environment assignment are not accepted.
- At least one validation command is required.
- Policy limits must be positive and cannot exceed implementation-wide ceilings documented by the CLI.

After validation, the core resolves `baseRef` to a commit and computes a SHA-256 task digest over the normalized task and resolved commit. Consent and all later state transitions bind to this digest.

## Run Lifecycle

A run follows this state machine:

```text
inspected
  -> awaiting_execution_consent
  -> prepared
  -> executing
  -> validating
  -> finalized
  -> awaiting_result_consent
  -> approved | failed | discarded

Any active state may become cancelled, failed, or frozen.
```

- `cancelled` means the user stopped the run or Agy ended before completion.
- `failed` means a normal operation prevented completion, or the user chose to save a local debugging bundle whose validation commands did not all pass.
- `frozen` means a policy invariant was violated. Frozen runs cannot be approved.

A nonzero validation exit does not skip finalization: the user can still inspect the patch and validation report. If the user saves that bundle, the terminal state is `failed`; only a bundle with passing validation can become `approved`.

The server records each transition as an append-only JSON Lines event. It rejects transitions that are out of order, use the wrong run identifier, or present a task digest different from the inspected task.

## MCP Tool Contract

The MVP exposes six host-neutral tools.

### `genki_inspect_task`

Input: absolute task-file path.

Behavior: parses and validates the task, resolves the repository commit, checks repository cleanliness and unsupported features, computes the task digest, and returns a consent summary. It does not create a clone.

The summary includes task title, repository path, resolved commit, instructions, validation commands, runtime and output limits, host name, and all data that may be saved.

### `genki_prepare_run`

Input: task-file path, task digest, and an explicit execution-consent assertion from the host.

Behavior: revalidates the task and digest, records the first consent, creates the disposable repository clone, creates an empty temporary home, and returns the run identifier and workspace path.

The MCP server can record that the host asserted user consent, but it cannot cryptographically prove a human gave that consent. The Agy skill must not call this tool until the user has replied affirmatively to the rendered summary.

### `genki_run_validation`

Input: run identifier.

Behavior: executes the exact validation argument arrays from the task in order, with individual and total time limits. It does not accept arbitrary commands from the host. It returns exit codes, durations, and bounded stdout/stderr summaries.

### `genki_finalize_run`

Input: run identifier.

Behavior: calculates a binary-safe Git diff, changed-file count, patch size, validation summary, and provenance hashes. It freezes the run if any output policy is exceeded. A successfully finalized run moves to the second consent gate.

### `genki_approve_result`

Input: run identifier, result digest, and an explicit result-consent assertion from the host.

Behavior: verifies that the displayed result digest is current, records the second consent, and persists the approved result bundle. A run with failed validation may be saved as a local debugging result, but its status is `failed`, never `approved` or a successful contribution.

### `genki_discard_run`

Input: run identifier.

Behavior: marks the run discarded, deletes generated patch output and the disposable clone, and retains only the minimum cancellation audit events.

## Agy Experience

The Agy plugin supplies:

- A valid Agy plugin manifest.
- An MCP configuration that starts the local Genki MCP server over `stdio`.
- A Genki workflow skill that recognizes requests to inspect or run a local task.
- Instructions that require the two user confirmations and prohibit direct validation commands outside the MCP tool.

The supported primary entry point is:

```bash
genki run --host agy /absolute/path/to/task.json
```

The CLI creates an empty, ephemeral session root, adds that root to the Agy workspace, starts Agy in sandbox mode, and provides the task path. No repository clone exists at that point. After the first consent, the MCP server creates the disposable clone inside the already-authorized session root. Inside that session, the user can use natural language such as:

```text
Run this Genki task.
```

Directly starting Agy and invoking the installed plugin is supported only when the user starts Agy with sandbox mode. The CLI-launched flow is the acceptance-test path because the MVP cannot independently prove that an already-running host session was sandboxed.

Agy remains responsible for its own authentication and model communication. Genki Node neither reads nor receives Agy credentials, session material, cookies, refresh tokens, or provider API keys.

## Disposable Workspace

After the first consent, Genki Node creates a run directory in its platform-specific local state directory and clones the source repository using local transport with hardlinks disabled. The clone checks out the resolved commit in a detached state.

The source repository must be clean. This prevents an operator from mistaking uncommitted source changes for task input and makes the task digest reproducible.

The disposable clone has independent Git metadata. Genki Node never commits, pushes, modifies refs in the source repository, or applies the generated patch back to it.

On approval, discard, cancellation, or ordinary failure, the clone is removed. A crash may leave a run directory behind; the next CLI launch reports it, and `genki runs cleanup` removes expired or explicitly selected orphaned runs.

## Process And Environment Policy

Validation commands run with direct process spawning and `shell: false`.

The child environment is constructed from an allowlist rather than copied from the parent. It contains only the executable search path, locale values, terminal type when needed, a run-specific temporary directory, a run-specific empty `HOME`, and explicit Genki metadata that contains no secret.

Common provider keys, cloud credentials, Git credential variables, SSH agent variables, proxy credential variables, and arbitrary parent environment values are not inherited. Logs record environment variable names only when needed for a policy error; values are never recorded.

The MCP server itself performs no remote requests. Agy model communication is expected and remains under Agy's existing local account controls. Because the MVP does not require Docker or an operating-system network sandbox, it cannot technically guarantee that every process is unable to reach the network. Validation tasks must therefore rely only on files tracked in the cloned repository and tools already available on the machine; dependency installation is outside MVP validation. Network isolation is explicitly deferred to the container hardening phase.

## Audit And Results

The run ledger is local and append-only. It records:

- Run identifier, task identifier, task digest, and resolved repository commit.
- State transitions and timestamps.
- The two host-asserted user confirmations.
- Validation executable names, argument arrays, exit codes, durations, and truncated output summaries.
- Changed relative file paths, patch size, patch hash, and result digest.
- Policy violations and bounded error metadata.

It does not record:

- Full Agy conversations or hidden reasoning.
- Provider credentials, session data, cookies, API keys, or environment values.
- Source files unrelated to the patch.
- Home-directory contents or arbitrary machine inventory.

An approved local result bundle contains:

```text
result.json
patch.diff
validation.json
audit.jsonl
```

No result is uploaded in the MVP.

## Error Handling

- Invalid task: return structured validation errors and create no run directory.
- Dirty or unsupported repository: block inspection with a specific remediation message.
- First consent denied: create no clone or persistent run record, save no result, and remove the empty launcher session root.
- Agy cancellation or timeout: mark the run cancelled and remove the clone.
- Validation command failure: retain the summary for review, classify the run as failed, and prevent successful approval.
- Runtime, file-count, patch-size, digest, or path violation: freeze the run and prevent approval.
- MCP process crash: preserve append-only events already flushed; report and clean orphaned state on the next CLI invocation.
- Second consent denied: delete patch output and the clone, retaining only minimal discard events.
- Cleanup failure: report the exact retained local path without silently claiming cleanup succeeded.

## Testing Strategy

### Unit Tests

- Accept valid version-1 tasks and reject malformed or oversized fields.
- Reject relative repository paths, dirty repositories, submodules, and escaping symlinks.
- Normalize tasks and produce stable task digests.
- Enforce valid and invalid run-state transitions.
- Spawn validation commands without a shell and with the environment allowlist.
- Remove seeded test secrets from child environments, logs, and result serialization.
- Enforce runtime, changed-file, patch-size, and output-truncation limits.
- Build deterministic result digests and result bundles.

### Integration Tests

- Create a temporary Git fixture, inspect a task, prepare a clone, modify the clone, run validation, finalize, approve, and verify the source repository is byte-for-byte and ref-for-ref unchanged.
- Exercise discard, cancellation, test failure, timeout, policy freeze, digest mismatch, and orphan cleanup.
- Start the MCP server over `stdio` and exercise all six tools through the MCP client protocol.
- Confirm that a seeded secret in the parent environment does not appear anywhere under the Genki state directory.

### Agy Smoke Test

- Validate the plugin with `agy plugin validate`.
- Install and enable the plugin locally.
- Launch the test through `genki run --host agy`.
- Use an intentionally failing fixture test and a bounded coding instruction.
- Observe both consent gates.
- Let Agy modify only the disposable clone and make the fixture test pass.
- Review the generated patch, validation report, and audit ledger.
- Confirm the original fixture repository is unchanged.
- Uninstall and reinstall the plugin to verify repeatable packaging.

## Acceptance Criteria

The MVP is complete when all of the following are true:

- The public repository contains reproducible build, test, lint, and plugin-install instructions.
- `agy plugin validate` succeeds for the packaged plugin.
- CLI and Agy natural-language flows use the same MCP server and core implementation.
- A real Agy model completes the local smoke task and produces a passing patch.
- Both consent gates are visible and recorded.
- The source repository and its Git metadata remain unchanged.
- Patch, validation report, result metadata, and minimum audit ledger are readable and internally consistent.
- A seeded secret cannot be found in any persisted Genki output.
- Unit, integration, MCP protocol, and Agy smoke tests pass.
- No Federation One, Signal, GitHub, provider-key storage, remote telemetry, Docker, or additional-host behavior is present.

## Known Security Limitations

The no-Docker choice keeps the first test easy to run but is not a strong sandbox. Agy sandbox mode, a disposable clone, direct command spawning, a clean environment, exact validation commands, and output limits reduce accidental harm; they do not protect against a malicious host process, operating-system compromise, or every possible repository-level exploit. The MCP server controls its own validation subprocesses, but it cannot prevent a compromised host agent from attempting to use other tools exposed by that host.

The first post-MVP hardening milestone is container-backed execution with explicit filesystem mounts and network policy. Public claims must describe the MVP as controlled local isolation, not secure arbitrary-code execution.

## Future Compatibility

Codex and Claude Code integrations will each provide a host manifest/configuration and workflow skill that map to the same six MCP tools. They must not fork task semantics, policy rules, run states, audit formats, or result formats.

Federation One connectivity will be added behind a separate task-source and result-sink boundary. The local task format remains useful as a test fixture and offline mode. Signal accounting remains outside Genki Node's local execution core and is not part of this MVP.
