import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { PartialCheckpoint, TaskDefinition } from "../../core/src/types.js";
import { LocalCoordinator } from "./local.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createFixture(): Promise<{ repository: string; queue: string; baseCommit: string }> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "genki-coord-repo-"));
  const queue = await mkdtemp(path.join(os.tmpdir(), "genki-coord-queue-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Genki Test");
  await git(repository, "config", "user.email", "genki@example.invalid");
  await writeFile(path.join(repository, "value.js"), 'export const value = "before";\n');
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "initial");
  const baseCommit = await git(repository, "rev-parse", "HEAD");
  const task: TaskDefinition = {
    schemaVersion: "1",
    id: "coord-task",
    title: "Local coordinator task",
    repository: { path: repository, baseRef: "HEAD" },
    instructions: "Edit the fixture.",
    validation: [{ argv: ["node", "--version"], timeoutSeconds: 10 }],
    policy: { maxRuntimeSeconds: 60, maxChangedFiles: 5, maxPatchBytes: 20_000 }
  };
  await writeFile(path.join(queue, "01-task.json"), `${JSON.stringify(task)}\n`);
  return { repository, queue, baseCommit };
}

function checkpoint(baseCommit: string): PartialCheckpoint {
  return {
    schemaVersion: "1",
    taskId: "coord-task",
    taskRevision: 1,
    attemptId: "attempt-1",
    leaseId: "lease-1",
    leaseGeneration: 1,
    baseCommit,
    patch: "diff --git a/value.js b/value.js\n",
    patchDigest: "a".repeat(64),
    changedFiles: ["value.js"],
    validation: null,
    host: "codex",
    hostOutcome: "capacity_unavailable",
    completedCriteria: [],
    remainingCriteria: [],
    createdAt: "2026-07-16T00:00:00.000Z"
  };
}

describe("LocalCoordinator", () => {
  it("leases one task at a time and increases generation after expiry", async () => {
    const { queue, baseCommit } = await createFixture();
    let now = new Date("2026-07-16T00:00:00.000Z");
    const ids = ["session-1", "token-1", "lease-1", "lease-2"];
    const coordinator = new LocalCoordinator({
      taskDirectory: queue,
      now: () => now,
      createId: () => ids.shift() ?? "extra",
      leaseDurationSeconds: 60
    });

    const session = await coordinator.openSession({
      policyDigest: "b".repeat(64),
      host: "codex",
      contributor: { displayName: null, slogan: null, email: null }
    });
    const first = await coordinator.leaseTask(session);
    expect(first).toMatchObject({
      taskId: "coord-task",
      leaseId: "lease-1",
      leaseGeneration: 1,
      project: { baseCommit }
    });
    expect(await coordinator.leaseTask(session)).toEqual(first);

    now = new Date("2026-07-16T00:02:00.000Z");
    const second = await coordinator.leaseTask(session);
    expect(second).toMatchObject({
      leaseId: "lease-2",
      leaseGeneration: 2
    });
  });

  it("rejects stale generations and keeps uploads idempotent", async () => {
    const { queue, baseCommit } = await createFixture();
    const ids = ["session-1", "token-1", "lease-1"];
    const coordinator = new LocalCoordinator({
      taskDirectory: queue,
      createId: () => ids.shift() ?? "extra"
    });
    const session = await coordinator.openSession({
      policyDigest: "b".repeat(64),
      host: "agy",
      contributor: { displayName: null, slogan: null, email: null }
    });
    const leased = await coordinator.leaseTask(session);
    expect(leased).not.toBeNull();

    const stale = await coordinator.uploadResult({
      sessionId: session.sessionId,
      token: session.token,
      leaseId: leased!.leaseId,
      leaseGeneration: 99,
      operationId: "op-stale",
      taskId: leased!.taskId,
      taskRevision: 1,
      attemptId: "attempt-1",
      baseCommit,
      patch: "diff",
      patchDigest: "c".repeat(64),
      changedFiles: ["value.js"],
      validation: null,
      host: "agy",
      hostOutcome: "completed",
      usage: null,
      completedCriteria: [],
      remainingCriteria: [],
      kind: "result"
    });
    expect(stale).toEqual({
      accepted: false,
      operationId: "op-stale",
      reason: "stale_lease"
    });

    const first = await coordinator.uploadCheckpoint({
      sessionId: session.sessionId,
      token: session.token,
      leaseId: leased!.leaseId,
      leaseGeneration: leased!.leaseGeneration,
      operationId: "op-cp",
      checkpoint: checkpoint(baseCommit)
    });
    const duplicate = await coordinator.uploadCheckpoint({
      sessionId: session.sessionId,
      token: session.token,
      leaseId: leased!.leaseId,
      leaseGeneration: leased!.leaseGeneration,
      operationId: "op-cp",
      checkpoint: checkpoint(baseCommit)
    });
    expect(first.reason).toBe("accepted");
    expect(duplicate.reason).toBe("duplicate");
    expect(coordinator.getAcceptedCheckpoint("coord-task")?.patchDigest).toBe("a".repeat(64));
  });

  it("rejects uploads after closeSession", async () => {
    const { queue, baseCommit } = await createFixture();
    const ids = ["session-1", "token-1", "lease-1"];
    const coordinator = new LocalCoordinator({
      taskDirectory: queue,
      createId: () => ids.shift() ?? "extra"
    });
    const session = await coordinator.openSession({
      policyDigest: "b".repeat(64),
      host: "agy",
      contributor: { displayName: null, slogan: null, email: null }
    });
    const leased = await coordinator.leaseTask(session);
    await coordinator.closeSession({ sessionId: session.sessionId, token: session.token });

    await expect(
      coordinator.uploadResult({
        sessionId: session.sessionId,
        token: session.token,
        leaseId: leased!.leaseId,
        leaseGeneration: leased!.leaseGeneration,
        operationId: "op-closed",
        taskId: leased!.taskId,
        taskRevision: 1,
        attemptId: "attempt-1",
        baseCommit,
        patch: "",
        patchDigest: "d".repeat(64),
        changedFiles: [],
        validation: null,
        host: "agy",
        hostOutcome: "interrupted",
        usage: null,
        completedCriteria: [],
        remainingCriteria: [],
        kind: "attempt_evidence"
      })
    ).rejects.toThrow(/closed/i);
  });
});
