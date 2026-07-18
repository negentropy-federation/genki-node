import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { runHostProcess } from "./process.js";
import type {
  HostAdapter,
  HostAvailability,
  HostOutcomeCode,
  HostProcessResult,
  HostRunInput,
  HostRunResult
} from "./types.js";

interface SemverApi {
  gte(version: string, minimum: string): boolean;
  valid(version: string): string | null;
}

const semver = createRequire(import.meta.url)("semver") as SemverApi;

const MINIMUM_AGY_VERSION = "1.1.2";
const AVAILABILITY_TIMEOUT_MS = 5_000;
const INHERITED_ENVIRONMENT_NAMES = ["PATH", "LANG", "LC_ALL", "TERM"] as const;

export interface AgyTaskOptions {
  workspace: string;
  logPath: string;
  prompt: string;
  model: string | null;
}

interface AgyHostAdapterOptions {
  availabilityTimeoutMs?: number;
  command?: string;
  parentEnvironment?: NodeJS.ProcessEnv;
}

function copyInheritedEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    const value = parentEnvironment[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function taskResult(outcome: HostOutcomeCode, exitCode: number | null): HostRunResult {
  return {
    host: "agy",
    outcome,
    exitCode,
    usage: null,
    completedCriteria: [],
    remainingCriteria: []
  };
}

function classifyResult(result: HostProcessResult): HostRunResult {
  if (result.aborted) {
    return taskResult("interrupted", result.exitCode);
  }
  if (result.timedOut) {
    return taskResult("timed_out", result.exitCode);
  }
  if (result.exitCode === 0) {
    return taskResult("completed", 0);
  }
  return taskResult("host_failed", result.exitCode);
}

function parseVersion(stdout: string): string | null {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(stdout.trim());
  return match?.[1] === undefined ? null : semver.valid(match[1]);
}

export function buildAgyTaskArgs(input: AgyTaskOptions): string[] {
  const args = [
    "--sandbox",
    "--dangerously-skip-permissions",
    "--new-project",
    "--add-dir",
    input.workspace,
    "--log-file",
    input.logPath
  ];
  if (input.model !== null) {
    args.push("--model", input.model);
  }
  args.push("--print", input.prompt);
  return args;
}

export class AgyHostAdapter implements HostAdapter {
  readonly name = "agy" as const;

  private readonly availabilityTimeoutMs: number;
  private readonly command: string;
  private readonly nativeHome: string;
  private readonly parentEnvironment: NodeJS.ProcessEnv;

  constructor(options: AgyHostAdapterOptions = {}) {
    this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? AVAILABILITY_TIMEOUT_MS;
    this.command = options.command ?? "agy";
    this.parentEnvironment = options.parentEnvironment ?? process.env;
    this.nativeHome = this.parentEnvironment.HOME ?? os.homedir();
  }

  async checkAvailability(): Promise<HostAvailability> {
    const environment = copyInheritedEnvironment(this.parentEnvironment);
    environment.HOME = this.nativeHome;
    environment.TMPDIR = this.parentEnvironment.TMPDIR ?? os.tmpdir();

    let result: HostProcessResult;
    try {
      result = await runHostProcess({
        command: this.command,
        args: ["--version"],
        workingDirectory: process.cwd(),
        environment,
        timeoutMs: this.availabilityTimeoutMs,
        terminateGraceMs: 0,
        abortSignal: new AbortController().signal
      });
    } catch {
      return { available: false, version: null, reason: "not_found" };
    }

    if (
      result.exitCode !== 0 ||
      result.aborted ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated
    ) {
      return { available: false, version: null, reason: "probe_failed" };
    }

    const version = parseVersion(result.stdout);
    if (version === null) {
      return { available: false, version: null, reason: "probe_failed" };
    }
    if (!semver.gte(version, MINIMUM_AGY_VERSION)) {
      return { available: false, version, reason: "unsupported_version" };
    }
    return { available: true, version, reason: "available" };
  }

  async runTask(input: HostRunInput): Promise<HostRunResult> {
    const temporaryHome = path.resolve(input.temporaryHome);
    const workspace = path.resolve(input.workspace);
    const logPath = path.join(temporaryHome, "agy.log");

    const environment = copyInheritedEnvironment(this.parentEnvironment);
    environment.HOME = this.nativeHome;
    environment.TMPDIR = temporaryHome;
    environment.GENKI_SESSION_ID = input.sessionId;
    environment.GENKI_TASK_ID = input.taskId;
    environment.GENKI_ATTEMPT_ID = input.attemptId;

    let result: HostProcessResult;
    try {
      result = await runHostProcess({
        command: this.command,
        args: buildAgyTaskArgs({
          workspace,
          logPath,
          prompt: input.instructions,
          model: input.model
        }),
        workingDirectory: workspace,
        environment,
        timeoutMs: Math.max(0, input.timeoutSeconds * 1_000),
        abortSignal: input.abortSignal
      });
    } catch {
      return taskResult("host_failed", null);
    }

    return classifyResult(result);
  }
}
