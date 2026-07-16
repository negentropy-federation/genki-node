import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

import type { HostProcessInput, HostProcessResult } from "./types.js";

const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 2_000;

interface BoundedOutput {
  append(chunk: Buffer): void;
  result(): { text: string; truncated: boolean };
}

function truncateUtf8(text: string, limitBytes: number): { text: string; truncated: boolean } {
  let capturedBytes = 0;
  let capturedCodeUnits = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (capturedBytes + characterBytes > limitBytes) {
      return { text: text.slice(0, capturedCodeUnits), truncated: true };
    }
    capturedBytes += characterBytes;
    capturedCodeUnits += character.length;
  }

  return { text, truncated: false };
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
    result() {
      const decoded = new TextDecoder("utf-8").decode(Buffer.concat(chunks, capturedBytes));
      const bounded = truncateUtf8(decoded, limitBytes);
      return {
        text: bounded.text,
        truncated: wasTruncated || bounded.truncated
      };
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
  let terminationCause: "timeout" | "abort" | undefined;

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
      child.off("error", onError);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.stdin.off("error", onStdinError);
    };

    const requestTermination = (cause: "timeout" | "abort") => {
      if (terminationCause === undefined) {
        if (spawned && !isRunning(child.exitCode, child.signalCode)) {
          return;
        }
        terminationCause = cause;
      }
      if (
        terminationCause !== cause ||
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
      requestTermination("abort");
    };

    const onError = () => {
      if (spawned) {
        return;
      }
      cleanup();
      reject(new Error("Failed to start host process"));
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onStdinError);

    child.once("spawn", () => {
      spawned = true;
      if (terminationCause !== undefined) {
        requestTermination(terminationCause);
      }
    });

    child.on("error", onError);

    child.once("close", (exitCode, signal) => {
      cleanup();
      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      resolve({
        exitCode,
        signal,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        timedOut: terminationCause === "timeout",
        aborted: terminationCause === "abort",
        durationMs: Date.now() - startedAt
      });
    });

    input.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (input.abortSignal.aborted) {
      onAbort();
    }

    const timeoutTimer = setTimeout(() => {
      requestTermination("timeout");
    }, input.timeoutMs);
    timeoutTimer.unref();

    child.stdin.end(input.stdin ?? "");
  });
}
