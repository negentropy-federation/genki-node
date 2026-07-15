import type { SessionState, TaskState } from "./types.js";

export class InvalidTransitionError extends Error {
  constructor(kind: "session" | "task", from: string, to: string) {
    super(`Invalid ${kind} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

const sessionTransitions: Readonly<Record<SessionState, ReadonlySet<SessionState>>> = {
  configured: new Set(["awaiting_session_consent"]),
  awaiting_session_consent: new Set(["active", "closed"]),
  active: new Set(["draining", "expired", "revoked"]),
  draining: new Set(["closed", "expired", "revoked"]),
  closed: new Set(),
  expired: new Set(),
  revoked: new Set()
};

const taskTransitions: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  queued: new Set(["policy_checked", "failed", "frozen"]),
  policy_checked: new Set(["prepared", "failed", "frozen"]),
  prepared: new Set(["executing", "failed", "frozen"]),
  executing: new Set(["validating", "failed", "frozen"]),
  validating: new Set(["finalizing", "failed", "frozen"]),
  finalizing: new Set(["delivered", "failed", "frozen"]),
  delivered: new Set(["purged"]),
  failed: new Set(["purged"]),
  frozen: new Set(["purged"]),
  purged: new Set()
};

export function transitionSession(from: SessionState, to: SessionState): SessionState {
  if (!sessionTransitions[from].has(to)) {
    throw new InvalidTransitionError("session", from, to);
  }
  return to;
}

export function transitionTask(from: TaskState, to: TaskState): TaskState {
  if (!taskTransitions[from].has(to)) {
    throw new InvalidTransitionError("task", from, to);
  }
  return to;
}
