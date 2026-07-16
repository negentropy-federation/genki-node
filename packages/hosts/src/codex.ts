import { createRequire } from "node:module";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runHostProcess } from "./process.js";
import type {
  HostAdapter,
  HostAvailability,
  HostOutcomeCode,
  HostProcessResult,
  HostRunInput,
  HostRunResult,
  HostUsage
} from "./types.js";

interface SemverApi {
  gte(version: string, minimum: string): boolean;
  valid(version: string): string | null;
}

const semver = createRequire(import.meta.url)("semver") as SemverApi;

const MINIMUM_CODEX_VERSION = "0.144.2";
const AVAILABILITY_TIMEOUT_MS = 5_000;
const SCHEMA_FILENAME = "codex-final-response.schema.json";
const INHERITED_ENVIRONMENT_NAMES = ["PATH", "LANG", "LC_ALL", "TERM"] as const;
const GENERIC_OUTPUT_ERROR = "Invalid Codex host output";

const FINAL_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    completedCriteria: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 32
    },
    remainingCriteria: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 32
    }
  },
  required: ["completedCriteria", "remainingCriteria"],
  additionalProperties: false
} as const;

export interface CodexTaskOptions {
  workspace: string;
  schemaPath: string;
  model: string | null;
}

export interface ParsedCodexRun {
  usage: HostUsage;
  completedCriteria: string[];
  remainingCriteria: string[];
}

interface CodexHostAdapterOptions {
  command?: string;
  parentEnvironment?: NodeJS.ProcessEnv;
}

interface ParsedCriteria {
  completedCriteria: string[];
  remainingCriteria: string[];
}

interface ScannedCodexRun {
  completedTurn: boolean;
  diagnostics: string[];
  invalidKnownEvent: boolean;
  malformedJsonl: boolean;
  usage: HostUsage | null;
  criteria: ParsedCriteria | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseUsage(value: unknown): HostUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const inputTokens = value.input_tokens;
  const cachedInputTokens = value.cached_input_tokens;
  const outputTokens = value.output_tokens;
  const reasoningOutputTokens = value.reasoning_output_tokens;
  if (
    !isTokenCount(inputTokens) ||
    !isTokenCount(cachedInputTokens) ||
    !isTokenCount(outputTokens) ||
    !isTokenCount(reasoningOutputTokens)
  ) {
    return null;
  }

  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

function isCriterionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((criterion) => typeof criterion === "string" && [...criterion].length <= 500)
  );
}

function parseCriteria(value: unknown): ParsedCriteria | null {
  if (!isRecord(value)) {
    return null;
  }

  const allowedKeys = new Set(["completedCriteria", "remainingCriteria"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return null;
  }
  if (!isCriterionList(value.completedCriteria) || !isCriterionList(value.remainingCriteria)) {
    return null;
  }

  return {
    completedCriteria: [...value.completedCriteria],
    remainingCriteria: [...value.remainingCriteria]
  };
}

function scanCodexJsonl(text: string): ScannedCodexRun {
  let completedTurn = false;
  const diagnostics: string[] = [];
  let invalidKnownEvent = false;
  let malformedJsonl = false;
  let usage: HostUsage | null = null;
  let criteria: ParsedCriteria | null = null;

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      malformedJsonl = true;
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }

    if (event.type === "error" || event.type === "turn.failed" || event.type === "turn.aborted") {
      diagnostics.push(JSON.stringify(event));
      continue;
    }

    if (event.type === "turn.completed") {
      completedTurn = true;
      const parsedUsage = parseUsage(event.usage);
      if (parsedUsage === null) {
        invalidKnownEvent = true;
      } else {
        usage = parsedUsage;
      }
      continue;
    }

    if (event.type !== "item.completed" || !isRecord(event.item)) {
      continue;
    }
    if (event.item.type !== "agent_message") {
      continue;
    }
    if (typeof event.item.text !== "string") {
      invalidKnownEvent = true;
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.item.text) as unknown;
    } catch {
      invalidKnownEvent = true;
      continue;
    }
    const parsedCriteria = parseCriteria(payload);
    if (parsedCriteria === null) {
      invalidKnownEvent = true;
    } else {
      criteria = parsedCriteria;
    }
  }

  return { completedTurn, diagnostics, invalidKnownEvent, malformedJsonl, usage, criteria };
}

export function buildCodexArgs(input: CodexTaskOptions): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--output-schema",
    input.schemaPath,
    "-C",
    input.workspace
  ];

  if (input.model !== null) {
    args.push("--model", input.model);
  }
  args.push("-");
  return args;
}

function normalizeScannedRun(scanned: ScannedCodexRun): ParsedCodexRun {
  if (
    !scanned.completedTurn ||
    scanned.invalidKnownEvent ||
    scanned.malformedJsonl ||
    scanned.usage === null ||
    scanned.criteria === null
  ) {
    throw new Error(GENERIC_OUTPUT_ERROR);
  }

  return {
    usage: scanned.usage,
    completedCriteria: scanned.criteria.completedCriteria,
    remainingCriteria: scanned.criteria.remainingCriteria
  };
}

export function parseCodexJsonl(text: string): ParsedCodexRun {
  return normalizeScannedRun(scanCodexJsonl(text));
}

function copyInheritedEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    const value = parent[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function hasQuotaEvidence(text: string): boolean {
  return /usage[ _-]?limit|quota(?:[ _-]?(?:exceeded|exhausted|reached|depleted)|\s+(?:(?:is|has\s+been)\s+)?(?:exceeded|exhausted|reached|depleted))|(?:exceeded|exhausted|reached|depleted)(?:\s+\w+){0,3}\s+quota|insufficient[ _-]?quota|credits?[ _-]?depleted|(?:no|zero|0)\s+(?:weighted\s+)?tokens?\s+(?:left|remaining)/iu.test(
    text
  );
}

function hasAuthenticationEvidence(text: string): boolean {
  return /authentication\s+(?:failed|required)|not\s+authenticated|unauthorized|invalid\s+(?:api[ _-]?)?key|codex\s+login|\b401\b/iu.test(
    text
  );
}

function hasRepeatedCapacityEvidence(text: string): boolean {
  const matches = text.match(
    /temporar(?:y|ily)\s+unavailable|service\s+unavailable|overloaded|capacity|try\s+again\s+later|\b429\b/giu
  );
  return (matches?.length ?? 0) >= 2;
}

function failureResult(
  outcome: Exclude<HostOutcomeCode, "completed">,
  exitCode: number | null
): HostRunResult {
  return {
    host: "codex",
    outcome,
    exitCode,
    usage: null,
    completedCriteria: [],
    remainingCriteria: []
  };
}

function classifyResult(
  processResult: HostProcessResult,
  parsed: ParsedCodexRun | null,
  diagnostics: string
): HostRunResult {
  if (processResult.aborted) {
    return failureResult("interrupted", processResult.exitCode);
  }
  if (processResult.timedOut) {
    return failureResult("timed_out", processResult.exitCode);
  }

  const evidence = `${diagnostics}\n${processResult.stderr}`;
  if (hasQuotaEvidence(evidence)) {
    return failureResult("quota_exhausted", processResult.exitCode);
  }
  if (hasAuthenticationEvidence(evidence)) {
    return failureResult("authentication_failed", processResult.exitCode);
  }
  if (hasRepeatedCapacityEvidence(evidence)) {
    return failureResult("capacity_unavailable", processResult.exitCode);
  }
  if (
    processResult.exitCode === 0 &&
    !processResult.stdoutTruncated &&
    !processResult.stderrTruncated &&
    parsed !== null
  ) {
    return {
      host: "codex",
      outcome: "completed",
      exitCode: processResult.exitCode,
      usage: parsed.usage,
      completedCriteria: parsed.completedCriteria,
      remainingCriteria: parsed.remainingCriteria
    };
  }
  return failureResult("host_failed", processResult.exitCode);
}

export class CodexHostAdapter implements HostAdapter {
  readonly name = "codex" as const;

  private readonly command: string;
  private readonly parentEnvironment: NodeJS.ProcessEnv;
  private readonly nativeHome: string;
  private readonly nativeCodexHome: string;

  constructor(options: CodexHostAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.parentEnvironment = options.parentEnvironment ?? process.env;
    this.nativeHome = this.parentEnvironment.HOME ?? os.homedir();
    this.nativeCodexHome =
      this.parentEnvironment.CODEX_HOME ?? path.join(this.nativeHome, ".codex");
  }

  async checkAvailability(): Promise<HostAvailability> {
    const environment = copyInheritedEnvironment(this.parentEnvironment);
    environment.HOME = this.nativeHome;
    environment.TMPDIR = this.parentEnvironment.TMPDIR ?? os.tmpdir();
    environment.CODEX_HOME = this.nativeCodexHome;

    let result: HostProcessResult;
    try {
      result = await runHostProcess({
        command: this.command,
        args: ["--version"],
        workingDirectory: process.cwd(),
        environment,
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
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

    const match = /^codex-cli\s+(\S+)\s*$/u.exec(result.stdout);
    const version = match?.[1] === undefined ? null : semver.valid(match[1]);
    if (version === null) {
      return { available: false, version: null, reason: "probe_failed" };
    }
    if (!semver.gte(version, MINIMUM_CODEX_VERSION)) {
      return { available: false, version, reason: "unsupported_version" };
    }
    return { available: true, version, reason: "available" };
  }

  async runTask(input: HostRunInput): Promise<HostRunResult> {
    const schemaPath = path.join(input.temporaryHome, SCHEMA_FILENAME);
    try {
      await mkdir(input.temporaryHome, { recursive: true, mode: 0o700 });
      await writeFile(schemaPath, `${JSON.stringify(FINAL_RESPONSE_SCHEMA, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await chmod(schemaPath, 0o600);
    } catch {
      throw new Error("Failed to prepare Codex task");
    }

    const environment = copyInheritedEnvironment(this.parentEnvironment);
    environment.HOME = input.temporaryHome;
    environment.TMPDIR = input.temporaryHome;
    environment.CODEX_HOME = this.nativeCodexHome;
    environment.GENKI_SESSION_ID = input.sessionId;
    environment.GENKI_TASK_ID = input.taskId;
    environment.GENKI_ATTEMPT_ID = input.attemptId;

    const processResult = await runHostProcess({
      command: this.command,
      args: buildCodexArgs({
        workspace: input.workspace,
        schemaPath,
        model: input.model
      }),
      workingDirectory: input.workspace,
      environment,
      stdin: input.instructions,
      timeoutMs: Math.max(0, input.timeoutSeconds * 1_000),
      abortSignal: input.abortSignal
    });

    let diagnostics = "";
    let parsed: ParsedCodexRun | null = null;
    try {
      const scanned = scanCodexJsonl(processResult.stdout);
      diagnostics = scanned.diagnostics.join("\n");
      parsed = normalizeScannedRun(scanned);
    } catch {
      parsed = null;
    }
    return classifyResult(processResult, parsed, diagnostics);
  }
}
