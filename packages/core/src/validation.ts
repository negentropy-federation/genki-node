import { spawn } from "node:child_process";

import type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationSummary
} from "./types.js";

interface ValidationInput {
  commands: ValidationCommand[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  maxTotalRuntimeSeconds: number;
  outputLimitBytes?: number;
}

interface BoundedOutput {
  append(chunk: Buffer): void;
  text(): string;
  truncated(): boolean;
}

function createBoundedOutput(limit: number): BoundedOutput {
  const chunks: Buffer[] = [];
  let size = 0;
  let wasTruncated = false;

  return {
    append(chunk) {
      const remaining = limit - size;
      if (remaining <= 0) {
        wasTruncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size += remaining;
        wasTruncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    truncated() {
      return wasTruncated;
    }
  };
}

async function runCommand(
  command: ValidationCommand,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimitBytes: number
): Promise<ValidationCommandResult> {
  const startedAt = Date.now();
  const stdout = createBoundedOutput(outputLimitBytes);
  const stderr = createBoundedOutput(outputLimitBytes);
  let timedOut = false;

  const child = spawn(command.argv[0], command.argv.slice(1), {
    cwd,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", (error) => {
        stderr.append(Buffer.from(error.message));
        resolve({ exitCode: null, signal: null });
      });
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    }
  );
  clearTimeout(timer);

  return {
    argv: [...command.argv],
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    timedOut,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated(),
    stderrTruncated: stderr.truncated()
  };
}

export async function runValidationCommands(input: ValidationInput): Promise<ValidationSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + input.maxTotalRuntimeSeconds * 1000;
  const results: ValidationCommandResult[] = [];
  const outputLimitBytes = input.outputLimitBytes ?? 64 * 1024;

  for (const command of input.commands) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    results.push(
      await runCommand(
        command,
        input.cwd,
        input.environment,
        Math.min(command.timeoutSeconds * 1000, remainingMs),
        outputLimitBytes
      )
    );
    if (results.at(-1)?.exitCode !== 0 || results.at(-1)?.timedOut === true) {
      break;
    }
  }

  return {
    passed:
      results.length === input.commands.length &&
      results.every((result) => result.exitCode === 0 && !result.timedOut),
    commands: results,
    durationMs: Date.now() - startedAt
  };
}
