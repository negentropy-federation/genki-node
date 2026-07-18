import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { cleanupSession } from "./cleanup.js";
import { GenkiEngine } from "./engine.js";
import { applyCheckpoint, cloneRepository, inspectRepository } from "./repository.js";
import { getSessionPaths, getTaskRunPaths } from "./storage.js";
import type { HostRunResult, SessionPolicy, TaskDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function createCodingFixture(name: string): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), `genki-${name}-`));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Genki Test");
  await git(repository, "config", "user.email", "genki@example.invalid");
  await writeFile(path.join(repository, "value.js"), 'export const value = "before";\n');
  await writeFile(
    path.join(repository, "value.test.js"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./value.js";\ntest("value", () => assert.equal(value, "after"));\n'
  );
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "initial");
  return repository;
}

function policy(retainUntilVerified = false): SessionPolicy {
  return {
    schemaVersion: "1",
    durationSeconds: 28_800,
    maxTasks: 10,
    maxTotalRuntimeSeconds: 7_200,
    maxTaskRuntimeSeconds: 900,
    maxChangedFiles: 20,
    maxPatchBytes: 200_000,
    allowedExecutables: ["node"],
    host: "agy",
    model: null,
    retainUntilVerified
  };
}

function task(id: string, repository: string): TaskDefinition {
  return {
    schemaVersion: "1",
    id,
    title: `Private title ${id}`,
    repository: { path: repository, baseRef: "HEAD" },
    instructions: `Private instructions ${id}`,
    validation: [{ argv: ["node", "--test"], timeoutSeconds: 30 }],
    policy: { maxRuntimeSeconds: 60, maxChangedFiles: 5, maxPatchBytes: 20_000 }
  };
}

async function writeTask(queue: string, filename: string, definition: TaskDefinition): Promise<void> {
  await writeFile(path.join(queue, filename), `${JSON.stringify(definition)}\n`, { mode: 0o600 });
}

describe("GenkiEngine", () => {
  it(
    "uses one session consent for multiple tasks and purges each delivered run",
    async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-engine-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-engine-queue-"));
    const firstRepository = await createCodingFixture("first");
    const secondRepository = await createCodingFixture("second");
    await writeTask(queue, "01-first.json", task("private-first", firstRepository));
    await writeTask(queue, "02-second.json", task("private-second", secondRepository));
    const ids = [
      "session-1",
      "run-1",
      "attempt-1",
      "lease-1",
      "run-2",
      "attempt-2",
      "lease-2"
    ];
    const engine = new GenkiEngine({ stateRoot, createId: () => ids.shift() ?? "unexpected" });

    const description = await engine.describeSession({ taskDirectory: queue, policy: policy() });
    const active = await engine.activateSession(description.sessionId, description.policyDigest);
    expect(active.state).toBe("active");

    for (const expectedRunId of ["run-1", "run-2"]) {
      const prepared = await engine.prepareNextTask(description.sessionId);
      expect(prepared?.runId).toBe(expectedRunId);
      await writeFile(path.join(prepared!.workspace, "value.js"), 'export const value = "after";\n');
      const validation = await engine.runValidation(expectedRunId);
      expect(validation.passed).toBe(true);
      const outcome = await engine.finalizeAndDeliver(expectedRunId);
      expect(outcome).toEqual({ code: "DELIVERED", passed: true });
      expect(await exists(prepared!.workspace)).toBe(false);
    }

    const status = await engine.sessionStatus(description.sessionId);
    expect(status).toMatchObject({ completed: 2, failed: 0, remaining: 0 });
    const visible = JSON.stringify(status);
    expect(visible).not.toContain("Private title");
    expect(visible).not.toContain("Private instructions");
    expect(visible).not.toContain(firstRepository);
    expect(visible).not.toContain("value.js");
    expect(await readFile(path.join(firstRepository, "value.js"), "utf8")).toContain("before");
    expect(await readFile(path.join(secondRepository, "value.js"), "utf8")).toContain("before");
    },
    30_000
  );

  it("retains a marked result only in developer verification mode", { timeout: 30_000 }, async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-engine-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-engine-queue-"));
    const repository = await createCodingFixture("retained");
    await writeTask(queue, "01-task.json", task("retained-task", repository));
    const ids = ["session-retained", "run-retained", "attempt-retained", "lease-retained"];
    const engine = new GenkiEngine({ stateRoot, createId: () => ids.shift() ?? "unexpected" });
    const description = await engine.describeSession({
      taskDirectory: queue,
      policy: policy(true)
    });
    await engine.activateSession(description.sessionId, description.policyDigest);
    const prepared = await engine.prepareNextTask(description.sessionId);
    await writeFile(path.join(prepared!.workspace, "value.js"), 'export const value = "after";\n');
    await engine.runValidation(prepared!.runId);
    await engine.finalizeAndDeliver(prepared!.runId);

    const sessionPaths = getSessionPaths(stateRoot, description.sessionId);
    const runPaths = getTaskRunPaths(sessionPaths, prepared!.runId);
    await expect(readFile(path.join(runPaths.root, "result.json"), "utf8")).resolves.toContain(
      '"code":"DELIVERED"'
    );
    await expect(readFile(path.join(runPaths.root, "patch.diff"), "utf8")).resolves.toContain("+export");
    await cleanupSession(stateRoot, description.sessionId);
    expect(await exists(runPaths.root)).toBe(false);
  });

  it("rejects out-of-policy tasks without another consent prompt", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-engine-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-engine-queue-"));
    const repository = await createCodingFixture("rejected");
    const rejected = task("rejected-task", repository);
    rejected.validation = [{ argv: ["curl", "https://example.invalid"], timeoutSeconds: 10 }];
    await writeTask(queue, "01-rejected.json", rejected);
    const ids = ["session-rejected"];
    const engine = new GenkiEngine({ stateRoot, createId: () => ids.shift() ?? "unexpected" });
    const description = await engine.describeSession({ taskDirectory: queue, policy: policy() });
    await engine.activateSession(description.sessionId, description.policyDigest);

    await expect(engine.prepareNextTask(description.sessionId)).resolves.toBeNull();
    await expect(engine.sessionStatus(description.sessionId)).resolves.toMatchObject({
      completed: 0,
      failed: 1,
      remaining: 0,
      lastOutcomeCode: "TASK_REJECTED"
    });
  });

  it("expires the session without starting another task", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-engine-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-engine-queue-"));
    await mkdir(queue, { recursive: true });
    let now = new Date("2026-07-16T00:00:00.000Z");
    const engine = new GenkiEngine({
      stateRoot,
      createId: () => "session-expiring",
      now: () => now
    });
    const description = await engine.describeSession({
      taskDirectory: queue,
      policy: { ...policy(), durationSeconds: 60 }
    });
    await engine.activateSession(description.sessionId, description.policyDigest);
    now = new Date("2026-07-16T00:02:00.000Z");

    await expect(engine.prepareNextTask(description.sessionId)).resolves.toBeNull();
    await expect(engine.sessionStatus(description.sessionId)).resolves.toMatchObject({
      state: "expired"
    });
  });

  it(
    "captures a partial checkpoint without consent prompts or host calls",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-engine-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-engine-queue-"));
      const repository = await createCodingFixture("checkpoint");
      const baseCommit = await git(repository, "rev-parse", "HEAD");
      await writeTask(queue, "01-checkpoint.json", task("checkpoint-task", repository));
      const ids = ["session-cp", "run-cp", "attempt-1", "lease-1"];
      const now = new Date("2026-07-16T00:00:00.000Z");
      const engine = new GenkiEngine({
        stateRoot,
        createId: () => ids.shift() ?? "unexpected",
        now: () => now
      });
      const description = await engine.describeSession({
        taskDirectory: queue,
        policy: { ...policy(true), host: "codex" }
      });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const prepared = await engine.prepareNextTask(description.sessionId);
      expect(prepared?.runId).toBe("run-cp");
      await writeFile(
        path.join(prepared!.workspace, "value.js"),
        'export const value = "after";\n'
      );

      const hostResult: HostRunResult = {
        host: "codex",
        outcome: "capacity_unavailable",
        exitCode: 1,
        usage: null,
        completedCriteria: [],
        remainingCriteria: ["Regression test passes."]
      };
      await engine.recordHostCompletion(prepared!.runId, hostResult);
      const checkpoint = await engine.checkpointRun(prepared!.runId, hostResult);

      expect(checkpoint).toEqual({
        schemaVersion: "1",
        taskId: "checkpoint-task",
        taskRevision: 1,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        leaseGeneration: 1,
        baseCommit,
        patch: checkpoint.patch,
        patchDigest: checkpoint.patchDigest,
        changedFiles: ["value.js"],
        validation: null,
        host: "codex",
        hostOutcome: "capacity_unavailable",
        completedCriteria: [],
        remainingCriteria: ["Regression test passes."],
        createdAt: "2026-07-16T00:00:00.000Z"
      });
      expect(checkpoint.patch).toContain('+export const value = "after";');
      expect(checkpoint.patchDigest).toMatch(/^[0-9a-f]{64}$/u);

      const sessionPaths = getSessionPaths(stateRoot, description.sessionId);
      const runPaths = getTaskRunPaths(sessionPaths, prepared!.runId);
      await expect(readFile(path.join(runPaths.root, "checkpoint.json"), "utf8")).resolves.toContain(
        '"hostOutcome":"capacity_unavailable"'
      );
      await expect(readFile(path.join(runPaths.root, "checkpoint.diff"), "utf8")).resolves.toContain(
        "+export"
      );

      // Second node: apply the captured checkpoint to a fresh clone of the same base.
      const destinationParent = await mkdtemp(path.join(os.tmpdir(), "genki-continue-"));
      const destination = path.join(destinationParent, "workspace");
      await cloneRepository(await inspectRepository(task("continue", repository)), destination);
      await applyCheckpoint(destination, checkpoint);
      await expect(readFile(path.join(destination, "value.js"), "utf8")).resolves.toContain(
        "after"
      );
    },
    30_000
  );

  it("rejects out-of-policy patches when checkpointing", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-engine-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-engine-queue-"));
    const repository = await createCodingFixture("oversize");
    const oversized = task("oversize-task", repository);
    oversized.policy = { maxRuntimeSeconds: 60, maxChangedFiles: 1, maxPatchBytes: 40 };
    await writeTask(queue, "01-oversize.json", oversized);
    const ids = ["session-over", "run-over", "attempt-over", "lease-over"];
    const engine = new GenkiEngine({ stateRoot, createId: () => ids.shift() ?? "unexpected" });
    const description = await engine.describeSession({
      taskDirectory: queue,
      policy: policy()
    });
    await engine.activateSession(description.sessionId, description.policyDigest);
    const prepared = await engine.prepareNextTask(description.sessionId);
    await writeFile(
      path.join(prepared!.workspace, "value.js"),
      'export const value = "a-much-longer-after-value-that-blows-the-byte-limit";\n'
    );
    await writeFile(path.join(prepared!.workspace, "extra.js"), "export const extra = 1;\n");

    const hostResult: HostRunResult = {
      host: "agy",
      outcome: "interrupted",
      exitCode: null,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    };
    await expect(engine.checkpointRun(prepared!.runId, hostResult)).rejects.toThrow(/policy/i);
    await expect(engine.sessionStatus(description.sessionId)).resolves.toMatchObject({
      lastOutcomeCode: "POLICY_FROZEN"
    });
  });
});
