import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { LocalCoordinator } from "../../packages/coordinator/src/local.js";
import { GenkiEngine } from "../../packages/core/src/engine.js";
import type { HostAdapter, HostRunResult } from "../../packages/hosts/src/types.js";
import type { SessionPolicy, TaskDefinition } from "../../packages/core/src/types.js";
import { runContributionSession } from "../../packages/orchestrator/src/session.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("attempt evidence", () => {
  it(
    "uploads usage evidence without a client-selected Signal amount",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-attempt-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-attempt-queue-"));
      const repository = await mkdtemp(path.join(os.tmpdir(), "genki-attempt-repo-"));
      await git(repository, "init", "-b", "main");
      await git(repository, "config", "user.name", "Genki Test");
      await git(repository, "config", "user.email", "genki@example.invalid");
      await writeFile(path.join(repository, "value.js"), "export const value = 1;\n");
      await git(repository, "add", ".");
      await git(repository, "commit", "-m", "initial");

      const task: TaskDefinition = {
        schemaVersion: "1",
        id: "attempt-task",
        title: "private title",
        repository: { path: repository, baseRef: "HEAD" },
        instructions: "private instructions",
        validation: [{ argv: ["node", "--version"], timeoutSeconds: 10 }],
        policy: { maxRuntimeSeconds: 60, maxChangedFiles: 3, maxPatchBytes: 10_000 }
      };
      await writeFile(path.join(queue, "01.json"), JSON.stringify(task));

      const policy: SessionPolicy = {
        schemaVersion: "1",
        durationSeconds: 1800,
        maxTasks: 1,
        maxTotalRuntimeSeconds: 600,
        maxTaskRuntimeSeconds: 120,
        maxChangedFiles: 5,
        maxPatchBytes: 20_000,
        allowedExecutables: ["node"],
        host: "codex",
        model: null,
        retainUntilVerified: false
      };

      const engine = new GenkiEngine({ stateRoot });
      const description = await engine.describeSession({ taskDirectory: queue, policy });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const coordinator = new LocalCoordinator({
        taskDirectory: queue,
        normalSignal: 100,
        dailyAttemptSignalCap: 5
      });

      const host: HostAdapter = {
        name: "codex",
        async checkAvailability() {
          return { available: true, version: "0.0.0", reason: "available" };
        },
        async runTask(): Promise<HostRunResult> {
          return {
            host: "codex",
            outcome: "quota_exhausted",
            exitCode: 1,
            usage: {
              inputTokens: 42,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0
            },
            completedCriteria: [],
            remainingCriteria: []
          };
        }
      };

      await runContributionSession({
        engine,
        coordinator,
        host,
        sessionId: description.sessionId,
        policy,
        policyDigest: description.policyDigest,
        resolveLocalRepository: (leased) => coordinator.resolveLocalRepository(leased)
      });

      const attempts = coordinator.listOperations().filter((op) => op.kind === "attempt_evidence");
      expect(attempts).toHaveLength(1);
      const payload = attempts[0]?.payload as { usage?: unknown; kind?: string };
      expect(payload.kind).toBe("attempt_evidence");
      expect(payload.usage).toEqual({
        inputTokens: 42,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0
      });
      expect(JSON.stringify(payload)).not.toMatch(/signalAmount|requestedSignal|award/iu);

      // Duplicate the same logical operation through the stored operation id.
      const operationId = attempts[0]!.operationId;
      const leased = {
        sessionId: "ignored",
        token: "ignored"
      };
      // Re-open is not required; LocalCoordinator idempotency is keyed by operationId.
      // Prove duplicate recognition via a second upload with the same operation id on a new lease.
      const session = await coordinator.openSession({
        policyDigest: description.policyDigest,
        host: "codex",
        contributor: { displayName: null, slogan: null, email: null }
      });
      const taskLease = await coordinator.leaseTask(session);
      const duplicate = await coordinator.uploadResult({
        sessionId: session.sessionId,
        token: session.token,
        leaseId: taskLease!.leaseId,
        leaseGeneration: taskLease!.leaseGeneration,
        operationId,
        taskId: "attempt-task",
        taskRevision: 1,
        attemptId: "attempt-dup",
        baseCommit: taskLease!.project.baseCommit,
        patch: "",
        patchDigest: "e".repeat(64),
        changedFiles: [],
        validation: null,
        host: "codex",
        hostOutcome: "quota_exhausted",
        usage: null,
        completedCriteria: [],
        remainingCriteria: [],
        kind: "attempt_evidence"
      });
      expect(duplicate.reason).toBe("duplicate");
      expect(coordinator.listAttemptAwards()).toHaveLength(1);
      expect(coordinator.listAttemptAwards()[0]?.award).toBe(1);
      expect(coordinator.listAttemptAwards()[0]?.award).toBeLessThanOrEqual(100 * 0.01);
      expect(coordinator.listAttemptAwards()[0]?.award).toBeLessThanOrEqual(5);
      void leased;
    },
    30_000
  );
});
