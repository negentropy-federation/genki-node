import type { HostName, HostOutcomeCode, HostUsage } from "../../core/src/types.js";

export type { HostName, HostOutcomeCode, HostUsage } from "../../core/src/types.js";

export interface HostAvailability {
  available: boolean;
  version: string | null;
  reason: "available" | "not_found" | "unsupported_version" | "probe_failed";
}

export interface HostRunInput {
  sessionId: string;
  taskId: string;
  attemptId: string;
  workspace: string;
  instructions: string;
  model: string | null;
  timeoutSeconds: number;
  temporaryHome: string;
  abortSignal: AbortSignal;
}

export interface HostRunResult {
  host: HostName;
  outcome: HostOutcomeCode;
  exitCode: number | null;
  usage: HostUsage | null;
  completedCriteria: string[];
  remainingCriteria: string[];
}

export interface HostAdapter {
  readonly name: HostName;
  checkAvailability(): Promise<HostAvailability>;
  runTask(input: HostRunInput): Promise<HostRunResult>;
}

export interface HostProcessInput {
  command: string;
  args: string[];
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  terminateGraceMs?: number;
}

export interface HostProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}
