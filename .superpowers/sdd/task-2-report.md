# Task 2 Report: Bounded Host Process Runner

## Status

DONE

## Commits

- `620ec20` (`feat: add bounded host adapter interface`) - Task 2 implementation and tests.

## Changed Files

- `packages/hosts/src/types.ts` - host adapter, availability, run, and process contracts.
- `packages/hosts/src/process.ts` - bounded `spawn()` runner with timeout and abort termination.
- `packages/hosts/src/process.test.ts` - real Node fixture process and boundary tests.
- `packages/hosts/src/index.ts` - package exports.

`tsconfig.json` and package metadata did not require changes.

## TDD RED Evidence

Command:

```bash
npm test -- packages/hosts/src/process.test.ts
```

Result: exited 1 as expected. Vitest reported that `./process.js` could not be found from
`packages/hosts/src/process.test.ts`, proving the new process boundary was absent before
implementation.

A second focused RED cycle covered synchronous startup failures:

```bash
npm test -- packages/hosts/src/process.test.ts -t "synchronously"
```

Result: exited 1 because Node's raw `spawn()` error was
`The argument 'file' cannot be empty. Received ''` instead of the required generic message.

## GREEN And Verification Evidence

```bash
npm run typecheck && npm test -- packages/hosts/src/process.test.ts
```

Result: exited 0; TypeScript passed and the then-current targeted suite passed 8/8 tests.

```bash
npm test -- packages/hosts/src/process.test.ts
```

Final targeted result: exited 0; 1 test file and 9/9 tests passed.

```bash
npm run typecheck && npm run lint
```

Result: exited 0; strict TypeScript and ESLint passed with no diagnostics.

```bash
npm test
```

Result: exited 0; 18/18 test files and 122/122 tests passed. This was the requested single final
full-suite run.

## Design Notes

- Reuses `HostName`, `HostOutcomeCode`, and `HostUsage` from Task 1 core types.
- Uses Node `child_process.spawn()` with `shell: false` and piped standard streams.
- Returns ordinary nonzero exits as `HostProcessResult`; synchronous and asynchronous startup
  failures reject with the generic message `Failed to start host process`.
- Captures stdout and stderr independently with 256 KiB defaults and truncation flags.
- Timeout or abort sends `SIGTERM`; a still-running child receives `SIGKILL` after the default
  2,000 ms grace period. Completion clears timeout, escalation timer, stream handlers, and the
  abort listener.
- Accepts the caller's already-sanitized environment exactly, so no provider-specific environment
  builder or third-party process dependency was added.
- Tests create a real temporary Node fixture and avoid shell interpretation.

## Self-Review

Reviewed committed diff `1ec0ea1..620ec20` against the Task 2 brief. The owned file scope is
respected, public interface shapes match the resolved decisions, output is not written to the
terminal, and timeout/abort promises settle only after the child closes. No blocking defects were
found.

## Concerns

- On macOS, Node injects `__CF_USER_TEXT_ENCODING` into child processes even when the supplied
  environment is otherwise empty (also reproduced through `/usr/bin/env -i`). The environment test
  permits only that platform-managed key beyond the caller's explicit allowlist and still rejects
  all other ambient variables.
- The optional independent Agy review produced no result because its first read-only run lacked
  command permission and the retry was stopped to honor the request to finish immediately. The
  required self-review was completed directly.
