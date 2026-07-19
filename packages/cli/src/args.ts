import path from "node:path";

import { parseSessionPolicy } from "../../core/src/schema.js";
import type { SessionPolicy } from "../../core/src/types.js";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type CoordinatorTarget = { kind: "local" } | { kind: "http"; url: string };

export type CliCommand =
  | { command: "help" }
  | {
      command: "contribute";
      taskDirectory: string;
      policy: SessionPolicy;
      coordinator: CoordinatorTarget;
    }
  | { command: "status" | "stop"; sessionId: string }
  | { command: "cleanup-session"; sessionId: string }
  | { command: "cleanup-expired" };

function parseDuration(value: string, label: string): number {
  const match = /^(\d+)(s|m|h)$/u.exec(value);
  if (match === null) {
    throw new CliUsageError(`${label} must use seconds, minutes, or hours, for example 30m`);
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  return amount * multiplier;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

function safeSessionId(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new CliUsageError("A valid session ID is required");
  }
  return value;
}

function parseCoordinator(value: string): CoordinatorTarget {
  if (value === "local") {
    return { kind: "local" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliUsageError("--coordinator must be 'local' or an absolute URL");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (parsed.protocol === "https:") {
    return { kind: "http", url: value };
  }
  if (parsed.protocol === "http:" && loopback) {
    return { kind: "http", url: value };
  }
  throw new CliUsageError("--coordinator remote URLs must use HTTPS (loopback HTTP allowed for tests)");
}

function parseContribute(argv: string[]): CliCommand {
  let taskDirectory: string | undefined;
  let coordinator: CoordinatorTarget = { kind: "local" };
  const policy: SessionPolicy = {
    schemaVersion: "1",
    durationSeconds: 28_800,
    maxTasks: 10,
    maxTotalRuntimeSeconds: 7_200,
    maxTaskRuntimeSeconds: 900,
    maxChangedFiles: 20,
    maxPatchBytes: 200_000,
    allowedExecutables: ["node", "npm"],
  allowedRepositoryClasses: ["public"],
    host: "agy",
    model: null,
    retainUntilVerified: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--retain-until-verified") {
      policy.retainUntilVerified = true;
      continue;
    }
    const value = requireValue(argv, index, option ?? "option");
    index += 1;
    switch (option) {
      case "--task-dir":
        taskDirectory = path.resolve(value);
        break;
      case "--host":
        if (value !== "agy" && value !== "codex") {
          throw new CliUsageError("--host must be agy or codex");
        }
        policy.host = value;
        break;
      case "--coordinator":
        coordinator = parseCoordinator(value);
        break;
      case "--duration":
        policy.durationSeconds = parseDuration(value, "duration");
        break;
      case "--max-tasks":
        policy.maxTasks = positiveInteger(value, "max tasks");
        break;
      case "--max-total-runtime":
        policy.maxTotalRuntimeSeconds = parseDuration(value, "max total runtime");
        break;
      case "--max-task-runtime":
        policy.maxTaskRuntimeSeconds = parseDuration(value, "max task runtime");
        break;
      case "--max-changed-files":
        policy.maxChangedFiles = positiveInteger(value, "max changed files");
        break;
      case "--max-patch-bytes":
        policy.maxPatchBytes = positiveInteger(value, "max patch bytes");
        break;
      case "--allow":
        policy.allowedExecutables = value.split(",").filter((name) => name.length > 0);
        break;
      case "--model":
        policy.model = value;
        break;
      default:
        throw new CliUsageError(`Unknown contribute option: ${option ?? ""}`);
    }
  }

  if (taskDirectory === undefined) {
    throw new CliUsageError("contribute requires --task-dir");
  }
  return {
    command: "contribute",
    taskDirectory,
    policy: parseSessionPolicy(policy),
    coordinator
  };
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      return { command: "help" };
    case "contribute":
      return parseContribute(rest);
    case "status":
    case "stop":
      if (rest.length !== 1) {
        throw new CliUsageError(`${command} requires exactly one session ID`);
      }
      return { command, sessionId: safeSessionId(rest[0]) };
    case "cleanup":
      if (rest.length === 2 && rest[0] === "--session") {
        return { command: "cleanup-session", sessionId: safeSessionId(rest[1]) };
      }
      if (rest.length === 1 && rest[0] === "--all-expired") {
        return { command: "cleanup-expired" };
      }
      throw new CliUsageError("cleanup requires --session <id> or --all-expired");
    case undefined:
      throw new CliUsageError("A command is required. Run genki --help.");
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}
