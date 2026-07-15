export type SessionState =
  | "configured"
  | "awaiting_session_consent"
  | "active"
  | "draining"
  | "closed"
  | "expired"
  | "revoked";

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
