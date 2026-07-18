# Federation One Contribution — Acceptance Script

Date: 2026-07-17

Status: Active acceptance script for the current milestone (Mode A — Federation
One contribution). Derived from the user-experience scenario for
`2026-07-16-federation-one-contribution-mvp-design.md`. This is the human-facing
"does it behave right" walkthrough that complements the automated test gate.

Scope note: this script covers **Mode A only** (donate compute → Federation One
→ Federation OS). The GitHub/VM open-source funding mode (Mode B) is future and
is recorded in `decisions/0006-github-project-funding-mode.md`; it has its own
acceptance script when picked up.

## Persona

"Kai" is a contributor with spare Codex (or Agy) capacity who wants to donate it
overnight. He is not shown task content and is never asked to approve individual
tasks. The same script applies to Agy by swapping `--host`.

---

## Scene 1 — Start (the one and only interaction)

**Given** Kai has Genki Node installed and a host (Agy or Codex) authenticated
locally,
**when** he runs:

```
genki contribute --host codex --duration 8h --max-tasks 10 --max-total-runtime 2h
```

**then** he sees exactly one authorization summary describing the session
envelope, and nothing starts until he accepts.

Acceptance checks:

- The summary shows: host, session duration + absolute expiry, max tasks, total
  and per-task runtime, max changed files / patch bytes, allowed validation
  executables, task network default-off, that patches and checkpoints upload
  automatically, optional contributor fields (name / slogan / email) behavior,
  the local paths Genki owns and will delete, and a persistent stop control.
- The summary states task details are hidden by default but inspectable by the
  machine owner (no confidentiality promise against the device owner).
- Declining removes the empty session root and starts no task.
- Accepting once transitions the session to active. **No further prompt appears
  for the rest of the session** — no per-task approval, no patch-upload
  approval, no checkpoint approval, no final-result approval.

## Scene 2 — Autonomous lease loop (hidden by default)

**Given** an active session,
**when** the node runs on its own,
**then** the contributor-visible surface shows only generic counters
(`Completed / Failed / Remaining`, elapsed, remaining runtime, last outcome
code) and never task content.

Acceptance checks (per task, none of which prompt Kai):

- The coordinator client leases one task at a time with an expiring lease and
  heartbeats.
- A task exceeding the accepted policy envelope is rejected automatically
  without asking for more access.
- The repository base commit is immutable; the node checks it out in a
  disposable, network-denied workspace clone.
- The host adapter spawns **one fresh host process and fresh model
  conversation** per task (unified host-adapter subprocess model for both Agy
  and Codex).
- The child environment is an allowlist: no provider keys, SSH agent, proxy
  creds, or unrelated parent env leak into the process.
- Declared validation commands run as argument arrays with `shell: false` and
  bounded output.
- A completed task uploads its patch automatically; a failed task is delivered
  as `failed` and never dressed up as success.
- Signal is recorded **server-side only**; the client cannot request its own
  award. A valid attempt with model usage but no useful patch may earn capped
  attempt Signal.
- The contributor-visible status, at every point, contains no task title,
  instructions, repository path, patch text, or command output.

## Scene 3 — Checkpoint / continuation

**Given** a task is interrupted (session expiry, timeout, capacity loss, or Kai
pressing stop) with useful code present,
**when** the node handles the interruption,
**then** it uploads a **code checkpoint automatically** and the task can be
continued elsewhere.

Acceptance checks:

- The checkpoint contains code state plus a bounded summary — **never**
  conversation history, hidden reasoning, or raw host transcript.
- Another node / a fresh model can apply the accepted checkpoint to the same
  immutable base commit and continue with a fresh conversation.
- To Kai this is invisible beyond the task leaving `Remaining`.

## Scene 4 — Stop and cleanup

**Given** Kai presses Ctrl-C (or the stop control fires, or the session
expires),
**when** the session ends,
**then** authorization is revoked immediately, the in-flight process is
terminated, a best-effort bounded final upload (failure metadata / checkpoint)
is attempted, and deterministic cleanup runs.

Acceptance checks:

- Cleanup is ordinary local code that runs with **no model call** and succeeds
  even with zero remaining model quota and the host binary unavailable.
- Cleanup removes only Genki-owned, marker-verified, matching-session,
  non-symlink directories: clones, patches, task payloads, journals, temporary
  homes, spill files, and any host log Genki explicitly redirected into the
  session root.
- Cleanup does **not** touch host/provider/OS records, terminal history,
  backups, or snapshots — and does not claim to.
- Default mode leaves no per-task local history after cleanup (an in-memory
  aggregate count may print before exit).

## Scene 5 — Contributor identity (lightweight, anonymous-friendly)

Acceptance checks:

- Optional `email` is private, encrypted at rest, never returned in public APIs,
  and — being unverified — is not used for authentication, authorization,
  recovery, or reward ownership.
- Anonymous sessions omit email; anonymous contributions cannot later be
  converted into an email-associated record.
- Null display name / slogan render with project-wide defaults (final public
  default name and slogan are still to be chosen).

---

## Host parity

Running the same script with `--host agy` must produce the same
contributor-visible experience (one consent, generic status, automatic upload,
same cleanup guarantees). The only difference is internal: Agy also runs under
the unified host-adapter subprocess model (one fresh process per task), which
replaces the Phase-1 "Agy loads the Genki MCP plugin and calls seven tools"
integration.

## Scene 6 — Source repository isolation

**Given** a task fixture references a clean source repository,
**when** a contribution session runs one or more tasks against it,
**then** the source repository is byte-for-byte identical after the session to
its state before the session.

Acceptance checks:

- **Before session**: `git -C <source> status --porcelain` outputs nothing
  (source is clean). If the source is dirty, `inspectRepository()` rejects the
  task and no work begins.
- **After session (including cleanup)**: `git -C <source> status --porcelain`
  still outputs nothing. Recursive file checksums (SHA-256 of all non-`.git`
  content) match the pre-session snapshot exactly.
- The automated gate includes `scripts/smoke-agy-isolation.sh` which performs
  this comparison mechanically and exits non-zero on any source mutation.
- A contribution session that mutates the source repository is a **test
  failure**, regardless of whether the task itself succeeded.
- The isolation mechanism is `git clone --no-local --no-hardlinks` into a
  disposable workspace — not an OS-grade sandbox. This milestone uses controlled
  local fixtures and first-party trusted repositories only.

---

## Relationship to the automated gate

This script is the qualitative acceptance pass. It sits on top of — and does not
replace — the automated test gate (the preserved Phase-1 74-test suite plus new
coordinator/orchestrator/host-adapter/checkpoint tests). A milestone is
"accepted" only when both the automated gate is green and every check above is
observed on real controlled-fixture runs with both Agy and Codex.
