import { spawn } from "node:child_process";

import type { HostProcessInput, HostProcessResult } from "./types.js";

const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 2_000;

interface BoundedOutput {
  append(chunk: Buffer): void;
  text(): string;
  truncated(): boolean;
}

function createBoundedOutput(limitBytes: number): BoundedOutput {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let wasTruncated = false;

  return {
    append(chunk) {
      const remainingBytes = limitBytes - capturedBytes;
      if (remainingBytes <= 0) {
        wasTruncated ||= chunk.length > 0;
        return;
      }

      const capturedChunk = chunk.subarray(0, remainingBytes);
      chunks.push(capturedChunk);
      capturedBytes += capturedChunk.length;
      wasTruncated ||= capturedChunk.length < chunk.length;
    },
    text() {
      return Buffer.concat(chunks, capturedBytes).toString("utf8");
    },
    truncated() {
      return wasTruncated;
    }
  };
}

function isRunning(exitCode: number | null, signalCode: NodeJS.Signals | null): boolean {
  return exitCode === null && signalCode === null;
}

function spawnHostProcess(input: HostProcessInput) {
  try {
    return spawn(input.command, input.args, {
      cwd: input.workingDirectory,
      env: input.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    throw new Error("Failed to start host process");
  }
}

export async function runHostProcess(input: HostProcessInput): Promise<HostProcessResult> {
  const startedAt = Date.now();
  const stdout = createBoundedOutput(input.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const stderr = createBoundedOutput(input.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const terminateGraceMs = input.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  let timedOut = false;
  let aborted = false;

  const child = spawnHostProcess(input);

  return await new Promise<HostProcessResult>((resolve, reject) => {
    let spawned = false;
    let terminationRequested = false;
    let killTimer: NodeJS.Timeout | undefined;

    const onStdout = (chunk: Buffer) => stdout.append(chunk);
    const onStderr = (chunk: Buffer) => stderr.append(chunk);
    const onStdinError = () => undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      input.abortSignal.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin.off("error", onStdinError);
    };

    const requestTermination = () => {
      if (
        !spawned ||
        terminationRequested ||
        !isRunning(child.exitCode, child.signalCode)
      ) {
        return;
      }

      terminationRequested = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (isRunning(child.exitCode, child.signalCode)) {
          child.kill("SIGKILL");
        }
      }, terminateGraceMs);
      killTimer.unref();
    };

    const onAbort = () => {
      aborted = true;
      requestTermination();
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onStdinError);

    child.once("spawn", () => {
      spawned = true;
      if (timedOut || aborted) {
        requestTermination();
      }
    });

    child.once("error", () => {
      cleanup();
      reject(new Error("Failed to start host process"));
    });

    child.once("close", (exitCode, signal) => {
      cleanup();
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt
      });
    });

    input.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (input.abortSignal.aborted) {
      onAbort();
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, input.timeoutMs);
    timeoutTimer.unref();

    child.stdin.end(input.stdin ?? "");
  });
}
