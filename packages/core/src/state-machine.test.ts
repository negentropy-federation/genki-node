import { describe, expect, it } from "vitest";

import { InvalidTransitionError, transitionSession, transitionTask } from "./state-machine.js";
import type { TaskState } from "./types.js";

describe("transitionSession", () => {
  it("allows the one-consent session lifecycle", () => {
    expect(transitionSession("configured", "awaiting_session_consent")).toBe(
      "awaiting_session_consent"
    );
    expect(transitionSession("awaiting_session_consent", "active")).toBe("active");
    expect(transitionSession("active", "draining")).toBe("draining");
    expect(transitionSession("draining", "closed")).toBe("closed");
  });

  it.each([
    ["configured", "active"],
    ["closed", "active"],
    ["expired", "active"],
    ["revoked", "active"]
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(() => transitionSession(from, to)).toThrow(InvalidTransitionError);
  });
});

describe("transitionTask", () => {
  it("allows delivery followed by purge", () => {
    const states = [
      "policy_checked",
      "prepared",
      "executing",
      "validating",
      "finalizing",
      "uploading_result",
      "delivered",
      "purged"
    ] as const;
    let current: TaskState = "queued";

    for (const next of states) {
      expect(transitionTask(current, next)).toBe(next);
      current = next;
    }
  });

  it("allows failed and frozen work to purge", () => {
    expect(transitionTask("executing", "failed")).toBe("failed");
    expect(transitionTask("failed", "purged")).toBe("purged");
    expect(transitionTask("validating", "frozen")).toBe("frozen");
    expect(transitionTask("frozen", "purged")).toBe("purged");
  });

  it("allows checkpoint upload followed by purge", () => {
    expect(transitionTask("executing", "checkpointing")).toBe("checkpointing");
    expect(transitionTask("checkpointing", "uploading_checkpoint")).toBe(
      "uploading_checkpoint"
    );
    expect(transitionTask("uploading_checkpoint", "checkpointed")).toBe("checkpointed");
    expect(transitionTask("checkpointed", "purged")).toBe("purged");
  });

  it.each([
    ["checkpointing", "failed"],
    ["checkpointing", "frozen"],
    ["uploading_checkpoint", "failed"],
    ["uploading_result", "failed"]
  ] as const)("allows recovery transition %s -> %s", (from, to) => {
    expect(transitionTask(from, to)).toBe(to);
  });

  it.each([
    ["queued", "executing"],
    ["purged", "prepared"],
    ["delivered", "executing"],
    ["finalizing", "delivered"],
    ["checkpointing", "checkpointed"],
    ["uploading_checkpoint", "frozen"],
    ["uploading_result", "frozen"],
    ["checkpointed", "executing"]
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(() => transitionTask(from, to)).toThrow(InvalidTransitionError);
  });
});
