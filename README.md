# Genki Node

Genki Node is the local contribution agent for the Negentropy Federation. A contributor authorizes one bounded session; Genki then leases tasks, runs one fresh Agy or Codex process per task, validates changes, and automatically uploads final patches or partial code checkpoints.

Task details are **hidden by default** in contributor-facing status. Cleanup is deterministic local code and does not delete Agy-owned records or provider-side history.

## Requirements

- Node.js 22.18 or newer
- Git
- Agy 1.1.2+ and/or Codex CLI 0.144.2+ for real host runs (optional for the automated gate)

## Build and install

```bash
npm install
npm run check
npm install -g .
```

### Agy plugin

```bash
agy plugin validate plugins/agy
agy plugin install ./plugins/agy
agy plugin list
```

### Codex plugin artifact

The repository ships a Codex plugin scaffold at `plugins/codex/genki-node` whose manifest name is exactly `genki-node`. Install it with your local Codex plugin workflow when experimenting; Genki's orchestrator still launches Codex as a one-task subprocess and does not depend on marketplace registration.

## Local contribution (default)

```bash
genki contribute --host agy --task-dir /absolute/path/to/tasks
genki contribute --host codex --task-dir /absolute/path/to/tasks
```

`--coordinator local` is the default and wraps the local task directory as leased fixtures. An experimental remote client is available as:

```bash
genki contribute --host agy --task-dir /absolute/path/to/tasks --coordinator https://coordinator.example.com
```

Remote coordinator mode is **experimental**. Arbitrary remote repositories remain disabled until outer-sandbox acceptance. Personal-plan Agy/Codex availability is not guaranteed. Optional contributor email is unverified metadata, not authentication.

Additional common flags:

```bash
genki contribute \
  --task-dir /absolute/path/to/tasks \
  --host agy \
  --duration 30m \
  --max-tasks 3 \
  --max-total-runtime 20m \
  --max-task-runtime 10m \
  --allow node,npm
```

The launcher shows the session policy once. After consent, patches and checkpoints upload automatically while the session remains authorized. Press Ctrl-C or run `genki stop` to revoke authorization.

```bash
genki status <session-id>
genki stop <session-id>
genki cleanup --session <session-id>
genki cleanup --all-expired
```

## Task queue

`--task-dir` must contain `.json` task files processed in filename order. Each source repository must be clean, absolute-path referenced, and free of configured submodules or escaping tracked symlinks.

```json
{
  "schemaVersion": "1",
  "id": "local-smoke-001",
  "title": "Local smoke task",
  "repository": {
    "path": "/absolute/path/to/clean/repository",
    "baseRef": "HEAD"
  },
  "instructions": "Update the fixture and keep its existing behavior.",
  "validation": [
    {
      "argv": ["node", "--test"],
      "timeoutSeconds": 30
    }
  ],
  "policy": {
    "maxRuntimeSeconds": 120,
    "maxChangedFiles": 5,
    "maxPatchBytes": 50000
  }
}
```

## Retained developer testing

```bash
genki contribute --task-dir /absolute/path/to/tasks --retain-until-verified
genki cleanup --session <session-id>
```

## Privacy and security boundary

- Genki does not ask for or persist passwords, cookies, session tokens, OAuth refresh tokens, or provider API keys.
- Host child environments use an allowlist and do not inherit arbitrary parent secrets.
- Work happens in an independent disposable clone. The source repository is not modified.
- Task details are hidden by default in contributor-facing output, but they are not secret from the machine owner.
- Normal cleanup covers Genki-owned session files, disposable workspaces, retained patches, checkpoints, validation output, and host logs redirected into the session directory.
- Agy-owned records outside the Genki state root, including conversations, history, brain data, provider records, and system logs, are not modified or covered by Genki's cleanup guarantee.
- Local cleanup does not delete provider-side records.
- Signal is calculated only on the server. The client never requests its own award.
- This milestone uses controlled local fixtures and first-party trusted repositories, not a full outer OS-grade sandbox for arbitrary third-party code.

## MVP limits

- Hosts: Agy and Codex only (experimental personal-plan adapters).
- Default coordinator is local; HTTP Federation One client is experimental.
- No production plan pooling, credential collection, remote daemon, or telemetry.
- Arbitrary remote/third-party repositories wait for the outer-sandbox gate.
