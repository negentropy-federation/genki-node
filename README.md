# Genki Node

Genki Node is the local contribution agent for the Negentropy Federation. This MVP lets a contributor authorize one bounded session, then lets Agy process a local queue of coding tasks through a local stdio MCP server.

The current release is a developer preview for local testing. It does not connect to Federation One, calculate Signal, accept provider credentials, or send results to a remote service.

## Requirements

- Node.js 22.18 or newer
- Git
- Agy 1.1.2 or a compatible release available as `agy`

## Build and install

```bash
npm install
npm run check
npm install -g .
```

Validate and install the Agy adapter:

```bash
agy plugin validate plugins/agy
agy plugin install ./plugins/agy
agy plugin list
```

Agy 1.1.2 enables a locally installed plugin automatically. If an existing installation was disabled, enable it explicitly with `agy plugin enable genki-node`.

To replace a previously installed development copy:

```bash
agy plugin disable genki-node
agy plugin uninstall genki-node
agy plugin install ./plugins/agy
agy plugin list
```

## Task queue

`--task-dir` must be a local directory containing one or more `.json` task files. Files are processed in filename order. Each source repository must be clean, must be referenced by an absolute path, and cannot contain configured submodules or tracked symlinks that escape the repository.

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

Validation commands are argument arrays, never shell command strings. Their executable basenames must be included in the session's `--allow` list.

## Start a contribution session

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

The launcher shows the bounded session policy and asks for consent once. After consent, Agy tool calls inside the dedicated sandboxed session are automatically approved so it can process tasks and deliver outcomes without per-task or result approval prompts. Press Ctrl-C to stop the host process; Genki then closes the normal session and removes its local session artifacts.

Check or stop a session from another terminal:

```bash
genki status <session-id>
genki stop <session-id>
```

Contributor-facing status is generic. Task instructions, repository paths, patches, and validation output are hidden by default.

## Retained developer testing

Use retention only when inspecting an MVP run locally:

```bash
genki contribute --task-dir /absolute/path/to/tasks --retain-until-verified
```

Retained runs live under `${GENKI_STATE_ROOT:-$HOME/.local/state/genki-node}` and may contain the task, disposable Git workspace, patch, validation output, and the redirected Agy log. Remove a retained session after inspection:

```bash
genki cleanup --session <session-id>
```

Expired marked sessions can be removed without Agy or model quota:

```bash
genki cleanup --all-expired
```

Cleanup uses local filesystem code and only removes directories carrying matching Genki ownership markers.

## Privacy and security boundary

- Genki does not ask for or persist passwords, cookies, session tokens, OAuth refresh tokens, or provider API keys.
- Validation receives a small environment allowlist and does not inherit arbitrary parent-process variables.
- Work happens in an independent disposable clone. The source repository is not modified.
- Task details are hidden by default in contributor-facing output, but they are not secret from the machine owner or from the local host executing the task.
- Normal cleanup covers Genki-owned session files, disposable workspaces, retained patches, validation output, and the Agy log redirected into the session directory.
- Agy-owned records outside the Genki state root, including its conversations, history, brain data, provider records, and system logs, are not modified or covered by Genki's cleanup guarantee.
- This MVP uses controlled local process isolation, not a container or virtual machine. Only run task queues from an operator you trust.

## MVP limits

- Agy is the only host adapter.
- Tasks and result delivery are local; no Federation One backend is connected.
- No Signal accounting is implemented.
- No provider plan pooling, credential collection, remote daemon, or telemetry is included.
