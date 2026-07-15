export type SessionState =
  | "configured"
  | "awaiting_session_consent"
  | "active"
  | "draining"
  | "closed"
  | "expired"
  | "revoked";

export type TaskState =
  | "queued"
  | "policy_checked"
  | "prepared"
  | "executing"
  | "validating"
  | "finalizing"
  | "delivered"
  | "failed"
  | "frozen"
  | "purged";

export interface SessionPolicy {
  schemaVersion: "1";
  durationSeconds: number;
  maxTasks: number;
  maxTotalRuntimeSeconds: number;
  maxTaskRuntimeSeconds: number;
  maxChangedFiles: number;
  maxPatchBytes: number;
  allowedExecutables: string[];
  host: "agy";
  model: string | null;
  retainUntilVerified: boolean;
}

export interface ValidationCommand {
  argv: [string, ...string[]];
  timeoutSeconds: number;
}

export interface TaskDefinition {
  schemaVersion: "1";
  id: string;
  title: string;
  repository: {
    path: string;
    baseRef: string;
  };
  instructions: string;
  validation: ValidationCommand[];
  policy: {
    maxRuntimeSeconds: number;
    maxChangedFiles: number;
    maxPatchBytes: number;
  };
}

export interface GenericSessionStatus {
  sessionId: string;
  state: SessionState;
  completed: number;
  failed: number;
  remaining: number;
  elapsedSeconds: number;
  remainingRuntimeSeconds: number;
  lastOutcomeCode: string | null;
}

export interface OwnershipMarker {
  format: "genki-owned-v1";
  kind: "session" | "task-run";
  sessionId: string;
  runId?: string;
  createdAt: string;
}

export interface SessionPaths {
  stateRoot: string;
  root: string;
  markerPath: string;
  sessionFile: string;
  runsRoot: string;
  agyLogPath: string;
}

export interface TaskRunPaths {
  root: string;
  markerPath: string;
  runFile: string;
  workspace: string;
  temporaryHome: string;
}

export interface CleanupReport {
  removedPaths: string[];
}

export interface RepositoryInspection {
  sourcePath: string;
  baseCommit: string;
}

export interface PatchSummary {
  patch: string;
  patchBytes: number;
  patchDigest: string;
  changedFiles: string[];
}

export interface ValidationCommandResult {
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ValidationSummary {
  passed: boolean;
  commands: ValidationCommandResult[];
  durationMs: number;
}

export interface SessionDescription {
  sessionId: string;
  policyDigest: string;
  sessionRoot: string;
  agyLogPath: string;
  summary: {
    durationSeconds: number;
    maxTasks: number;
    maxTotalRuntimeSeconds: number;
    maxTaskRuntimeSeconds: number;
    allowedExecutables: string[];
    host: "agy";
    model: string | null;
    retainUntilVerified: boolean;
  };
}

export interface PreparedTaskForHost {
  runId: string;
  workspace: string;
  instructions: string;
}

export interface GenericTaskOutcome {
  code: "DELIVERED" | "POLICY_FROZEN" | "VALIDATION_FAILED";
  passed: boolean;
}
