import type {
  HostName,
  HostOutcomeCode,
  HostUsage,
  LeasedTask,
  PartialCheckpoint,
  BoundedValidationSummary
} from "../../core/src/types.js";

export interface ContributorClaim {
  displayName: string | null;
  slogan: string | null;
  email: string | null;
}

export interface CoordinatorPolicySnapshot {
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
  executionNetwork: "none";
}

export interface OpenSessionInput {
  policyDigest: string;
  policy: CoordinatorPolicySnapshot;
  contributor: ContributorClaim;
}

export interface CoordinatorSession {
  sessionId: string;
  token: string;
  expiresAt: string;
}

export interface LeaseStatus {
  leaseId: string;
  leaseGeneration: number;
  active: boolean;
  expiresAt: string;
}

export interface LeaseHeartbeat {
  sessionId: string;
  token: string;
  leaseId: string;
  leaseGeneration: number;
}

export interface CheckpointUpload {
  sessionId: string;
  token: string;
  leaseId: string;
  leaseGeneration: number;
  operationId: string;
  checkpoint: PartialCheckpoint;
}

export interface ResultUpload {
  sessionId: string;
  token: string;
  leaseId: string;
  leaseGeneration: number;
  operationId: string;
  taskId: string;
  taskRevision: number;
  attemptId: string;
  baseCommit: string;
  patch: string;
  patchDigest: string;
  changedFiles: string[];
  validation: BoundedValidationSummary | null;
  host: HostName;
  hostOutcome: HostOutcomeCode;
  usage: HostUsage | null;
  completedCriteria: string[];
  remainingCriteria: string[];
  kind: "result" | "attempt_evidence";
}

export interface CloseSessionInput {
  sessionId: string;
  token: string;
}

export interface UploadAck {
  accepted: boolean;
  operationId: string;
  reason: "accepted" | "duplicate" | "stale_lease" | "session_closed" | "policy_rejected";
}

export interface CoordinatorClient {
  openSession(input: OpenSessionInput): Promise<CoordinatorSession>;
  leaseTask(session: CoordinatorSession): Promise<LeasedTask | null>;
  heartbeat(input: LeaseHeartbeat): Promise<LeaseStatus>;
  uploadCheckpoint(input: CheckpointUpload): Promise<UploadAck>;
  uploadResult(input: ResultUpload): Promise<UploadAck>;
  closeSession(input: CloseSessionInput): Promise<void>;
}
