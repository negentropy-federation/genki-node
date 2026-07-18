import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { LocalCoordinator } from "../../coordinator/src/local.js";
import { GenkiEngine } from "../../core/src/engine.js";
import type { HostRunResult, SessionPolicy, TaskDefinition } from "../../core/src/types.js";
import type { HostAdapter, HostRunInput } from "../../hosts/src/types.js";
import { runContributionSession } from "./session.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createRepo(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "genki-orch-repo-"));
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

function policy(): SessionPolicy {
  return {
    schemaVersion: "1",
    durationSeconds: 3_600,
    maxTasks: 5,
    maxTotalRuntimeSeconds: 1_800,
    maxTaskRuntimeSeconds: 300,
    maxChangedFiles: 10,
    maxPatchBytes: 100_000,
    allowedExecutables: ["node"],
    host: "codex",
    model: null,
    retainUntilVerified: false
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
    policy: { maxRuntimeSeconds: 120, maxChangedFiles: 5, maxPatchBytes: 50_000 }
  };
}

class ScriptedHost implements HostAdapter {
  readonly name = "codex" as const;
  readonly calls: HostRunInput[] = [];
  #script: Array<(input: HostRunInput) => Promise<HostRunResult> | HostRunResult>;

  constructor(script: Array<(input: HostRunInput) => Promise<HostRunResult> | HostRunResult>) {
    this.#script = script;
  }

  async checkAvailability() {
    return { available: true, version: "0.0.0", reason: "available" as const };
  }

  async runTask(input: HostRunInput): Promise<HostRunResult> {
    this.calls.push(input);
    const next = this.#script.shift();
    if (next === undefined) {
      throw new Error("Unexpected host invocation");
    }
    return next(input);
  }
}

describe("runContributionSession", () => {
  it(
    "leases, executes once, validates, uploads, cleans, and continues without re-consent",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-orch-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-orch-queue-"));
      const repoA = await createRepo();
      const repoB = await createRepo();
      await writeFile(path.join(queue, "01-a.json"), JSON.stringify(task("task-a", repoA)));
      await writeFile(path.join(queue, "02-b.json"), JSON.stringify(task("task-b", repoB)));

      const ids = [
        "session-1",
        "coord-session",
        "coord-token",
        "lease-a",
        "run-a",
        "attempt-a",
        "lease-b",
        "run-b",
        "attempt-b"
      ];
      const engine = new GenkiEngine({
        stateRoot,
        createId: () => ids.shift() ?? `id-${ids.length}`
      });
      const description = await engine.describeSession({
        taskDirectory: queue,
        policy: policy()
      });
      await engine.activateSession(description.sessionId, description.policyDigest);

      const coordinator = new LocalCoordinator({
        taskDirectory: queue,
        createId: () => ids.shift() ?? `coord-${ids.length}`
      });
      const host = new ScriptedHost([
        async (input) => {
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "after";\n');
          return {
            host: "codex",
            outcome: "completed",
            exitCode: 0,
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              reasoningOutputTokens: 0
            },
            completedCriteria: ["Private title task-a"],
            remainingCriteria: []
          };
        },
        async (input) => {
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "after";\n');
          return {
            host: "codex",
            outcome: "completed",
            exitCode: 0,
            usage: null,
            completedCriteria: ["Private title task-b"],
            remainingCriteria: []
          };
        }
      ]);

      const logs: string[] = [];
      const summary = await runContributionSession({
        engine,
        coordinator,
        host,
        sessionId: description.sessionId,
        policy: policy(),
        policyDigest: description.policyDigest,
        resolveLocalRepository: (leased) => coordinator.resolveLocalRepository(leased),
        onStatus: (status) => {
          logs.push(JSON.stringify(status));
        }
      });

      expect(summary.completed).toBe(2);
      expect(host.calls).toHaveLength(2);
      expect(coordinator.listOperations().filter((op) => op.kind === "result")).toHaveLength(2);
      expect(await readFile(path.join(repoA, "value.js"), "utf8")).toContain("before");
      const visible = logs.join("\n");
      expect(visible).not.toContain("Private title");
      expect(visible).not.toContain("Private instructions");
      expect(visible).not.toContain(repoA);
    },
    60_000
  );

  it(
    "uploads a checkpoint on capacity loss and attempt evidence on empty patch",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-orch-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-orch-queue-"));
      const repo = await createRepo();
      await writeFile(path.join(queue, "01.json"), JSON.stringify(task("cp-task", repo)));
      await writeFile(
        path.join(queue, "02.json"),
        JSON.stringify(task("empty-task", await createRepo()))
      );

      const engine = new GenkiEngine({ stateRoot });
      const description = await engine.describeSession({
        taskDirectory: queue,
        policy: policy()
      });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const coordinator = new LocalCoordinator({ taskDirectory: queue });
      const host = new ScriptedHost([
        async (input) => {
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "mid";\n');
          return {
            host: "codex",
            outcome: "capacity_unavailable",
            exitCode: 1,
            usage: null,
            completedCriteria: [],
            remainingCriteria: ["Private title cp-task"]
          };
        },
        async () => ({
          host: "codex",
          outcome: "quota_exhausted",
          exitCode: 1,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0
          },
          completedCriteria: [],
          remainingCriteria: []
        })
      ]);

      await runContributionSession({
        engine,
        coordinator,
        host,
        sessionId: description.sessionId,
        policy: policy(),
        policyDigest: description.policyDigest,
        resolveLocalRepository: (leased) => coordinator.resolveLocalRepository(leased)
      });

      const ops = coordinator.listOperations();
      expect(ops.some((op) => op.kind === "checkpoint")).toBe(true);
      expect(ops.some((op) => op.kind === "attempt_evidence")).toBe(true);
      const awards = coordinator.listAttemptAwards();
      expect(awards).toHaveLength(1);
      expect(awards[0]?.award).toBeLessThanOrEqual(1);
    },
    60_000
  );

  it("stops leasing after session abort", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-orch-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-orch-queue-"));
    const repo = await createRepo();
    await writeFile(path.join(queue, "01.json"), JSON.stringify(task("stop-task", repo)));
    const engine = new GenkiEngine({ stateRoot });
    const description = await engine.describeSession({
      taskDirectory: queue,
      policy: policy()
    });
    await engine.activateSession(description.sessionId, description.policyDigest);
    const coordinator = new LocalCoordinator({ taskDirectory: queue });
    const controller = new AbortController();
    const host = new ScriptedHost([
      async () => {
        controller.abort();
        return {
          host: "codex",
          outcome: "interrupted",
          exitCode: null,
          usage: null,
          completedCriteria: [],
          remainingCriteria: []
        };
      }
    ]);

    const summary = await runContributionSession({
      engine,
      coordinator,
      host,
      sessionId: description.sessionId,
      policy: policy(),
      policyDigest: description.policyDigest,
      resolveLocalRepository: (leased) => coordinator.resolveLocalRepository(leased),
      abortSignal: controller.signal
    });

    expect(summary.stopped).toBe(true);
    expect(host.calls).toHaveLength(1);
  });

  it(
    "does not upload a result when source repository is contaminated",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-orch-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-orch-queue-"));
      const repo = await createRepo();
      await writeFile(path.join(queue, "01.json"), JSON.stringify(task("contam-task", repo)));

      const engine = new GenkiEngine({ stateRoot });
      const description = await engine.describeSession({
        taskDirectory: queue,
        policy: { ...policy(), maxTasks: 1 }
      });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const coordinator = new LocalCoordinator({ taskDirectory: queue });
      const controller = new AbortController();
      const host = new ScriptedHost([
        async (input) => {
          // Contaminate the source repo
          await writeFile(path.join(repo, "contaminated.txt"), "oops");
          
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "after";\n');
          controller.abort();
          return {
            host: "codex",
            outcome: "completed",
            exitCode: 0,
            usage: null,
            completedCriteria: [],
            remainingCriteria: []
          };
        }
      ]);

      const summary = await runContributionSession({
        engine,
        coordinator,
        host,
        sessionId: description.sessionId,
        policy: policy(),
        policyDigest: description.policyDigest,
        resolveLocalRepository: (leased) => coordinator.resolveLocalRepository(leased),
        abortSignal: controller.signal
      });

      expect(summary.completed).toBe(0);
      expect(summary.failed).toBeGreaterThan(0);
      expect(summary.lastOutcomeCode).toBe("SOURCE_CONTAMINATION");

      const ops = coordinator.listOperations();
      const results = ops.filter((op) => op.kind === "result");
      expect(results).toHaveLength(0);
    },
    60_000
  );

  it(
    "does not upload a result when validation fails (fail-closed for all non-passed outcomes)",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-orch-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-orch-queue-"));
      const repo = await createRepo();
      await writeFile(path.join(queue, "01.json"), JSON.stringify(task("valfail-task", repo)));

      const engine = new GenkiEngine({ stateRoot });
      const description = await engine.describeSession({
        taskDirectory: queue,
        policy: { ...policy(), maxTasks: 1 }
      });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const coordinator = new LocalCoordinator({ taskDirectory: queue });
      const host = new ScriptedHost([
        async (input) => {
          // Write a value that does NOT satisfy the validation test
          // (test expects "after" but we write "wrong")
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "wrong";\n');
          return {
            host: "codex",
            outcome: "completed",
            exitCode: 0,
            usage: null,
            completedCriteria: [],
            remainingCriteria: []
          };
        }
      ]);

      const summary = await runContributionSession({
        engine,
        coordinator,
        host,
        sessionId: description.sessionId,
        policy: { ...policy(), maxTasks: 1 },
        policyDigest: description.policyDigest,
        resolveLocalRepository: (leased) => coordinator.resolveLocalRepository(leased)
      });

      expect(summary.completed).toBe(0);
      expect(summary.failed).toBeGreaterThan(0);
      expect(summary.lastOutcomeCode).toBe("VALIDATION_FAILED");

      const ops = coordinator.listOperations();
      const results = ops.filter((op) => op.kind === "result");
      expect(results).toHaveLength(0);
    },
    60_000
  );
});
