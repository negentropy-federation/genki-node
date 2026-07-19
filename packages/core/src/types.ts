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
  | "checkpointing"
  | "uploading_checkpoint"
  | "checkpointed"
  | "validating"
  | "finalizing"
  | "uploading_result"
  | "delivered"
  | "failed"
  | "frozen"
  | "purged";

export type HostName = "agy" | "codex";

export type HostOutcomeCode =
  | "completed"
  | "quota_exhausted"
  | "capacity_unavailable"
  | "authentication_failed"
  | "host_failed"
  | "interrupted"
  | "timed_out";

export interface HostUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface HostRunResult {
  host: HostName;
  outcome: HostOutcomeCode;
  exitCode: number | null;
  usage: HostUsage | null;
  completedCriteria: string[];
  remainingCriteria: string[];
}

export const ACCEPTED_SPDX_LICENSES = [
  "Apache-2.0",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later"
] as const;

export type AcceptedSpdxLicense = (typeof ACCEPTED_SPDX_LICENSES)[number];

export interface SessionPolicy {
  schemaVersion: "1";
  durationSeconds: number;
  maxTasks: number;
  maxTotalRuntimeSeconds: number;
  maxTaskRuntimeSeconds: number;
  maxChangedFiles: number;
  maxPatchBytes: number;
  allowedExecutables: string[];
  allowedRepositoryClasses: ("public" | "first_party_private")[];
  host: HostName;
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

export interface CheckpointReference {
  checkpointId: string;
  baseCommit: string;
  patchDigest: string;
}

export interface LeasedTaskProject {
  projectId: string;
  repositoryUrl: string;
  repositoryClass: "public" | "first_party_private";
  licenseSpdx: AcceptedSpdxLicense | null;
  baseCommit: string;
}

export interface LeasedTaskPolicy {
  maxRuntimeSeconds: number;
  maxChangedFiles: number;
  maxPatchBytes: number;
  executionNetwork: "none";
  dependencyDomains: string[];
}

export interface LeasedTask {
  schemaVersion: "2";
  taskId: string;
  revision: number;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  project: LeasedTaskProject;
  goal: string;
  acceptanceCriteria: string[];
  validation: ValidationCommand[];
  policy: LeasedTaskPolicy;
  predecessorCheckpoint: CheckpointReference | null;
}

export interface BoundedValidationCommandSummary {
  executable: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface BoundedValidationSummary {
  passed: boolean;
  commands: BoundedValidationCommandSummary[];
  durationMs: number;
}

export interface PartialCheckpoint {
  schemaVersion: "1";
  taskId: string;
  taskRevision: number;
  attemptId: string;
  leaseId: string;
  leaseGeneration: number;
  baseCommit: string;
  patch: string;
  patchDigest: string;
  changedFiles: string[];
  validation: BoundedValidationSummary | null;
  host: HostName;
  hostOutcome: HostOutcomeCode;
  completedCriteria: string[];
  remainingCriteria: string[];
  createdAt: string;
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
  workspacesRoot: string;
  homesRoot: string;
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
    host: HostName;
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
  code: "DELIVERED" | "POLICY_FROZEN" | "VALIDATION_FAILED" | "SOURCE_CONTAMINATION";
  passed: boolean;
}
