import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { LocalCoordinator } from "../../packages/coordinator/src/local.js";
import { GenkiEngine } from "../../packages/core/src/engine.js";
import type { HostAdapter, HostRunInput, HostRunResult } from "../../packages/hosts/src/types.js";
import type { SessionPolicy, TaskDefinition } from "../../packages/core/src/types.js";
import { runContributionSession } from "../../packages/orchestrator/src/session.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

class ScriptedHost implements HostAdapter {
  readonly name: "agy" | "codex";
  readonly conversationIds: string[] = [];
  #script: Array<(input: HostRunInput) => Promise<HostRunResult>>;

  constructor(
    name: "agy" | "codex",
    script: Array<(input: HostRunInput) => Promise<HostRunResult>>
  ) {
    this.name = name;
    this.#script = script;
  }

  async checkAvailability() {
    return { available: true, version: "0.0.0", reason: "available" as const };
  }

  async runTask(input: HostRunInput): Promise<HostRunResult> {
    this.conversationIds.push(`${this.name}:${input.attemptId}`);
    const next = this.#script.shift();
    if (next === undefined) {
      throw new Error("unexpected host call");
    }
    return next(input);
  }
}

describe("checkpoint continuation", () => {
  it(
    "continues from an accepted checkpoint with a fresh host conversation",
    async () => {
      const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-cont-state-"));
      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-cont-queue-"));
      const repository = await mkdtemp(path.join(os.tmpdir(), "genki-cont-repo-"));
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

      const task: TaskDefinition = {
        schemaVersion: "1",
        id: "continue-task",
        title: "Continue privately",
        repository: { path: repository, baseRef: "HEAD" },
        instructions: "secret goal text",
        validation: [{ argv: ["node", "--test"], timeoutSeconds: 30 }],
        policy: { maxRuntimeSeconds: 120, maxChangedFiles: 5, maxPatchBytes: 50_000 }
      };
      await writeFile(path.join(queue, "01.json"), JSON.stringify(task));

      const policy: SessionPolicy = {
        schemaVersion: "1",
        durationSeconds: 3600,
        maxTasks: 3,
        maxTotalRuntimeSeconds: 1800,
        maxTaskRuntimeSeconds: 300,
        maxChangedFiles: 10,
        maxPatchBytes: 100_000,
        allowedExecutables: ["node"],
  allowedRepositoryClasses: ["public"],
        host: "agy",
        model: null,
        retainUntilVerified: false
      };

      const engine = new GenkiEngine({ stateRoot });
      const description = await engine.describeSession({ taskDirectory: queue, policy });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const coordinator = new LocalCoordinator({
        taskDirectory: queue,
        leaseDurationSeconds: 30
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      coordinator.downloadCheckpoint = async (_checkpointId) => {
        for (const op of coordinator.listOperations()) {
          if (op.kind === "checkpoint") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const chk = op.payload as { checkpoint: any };
            return chk.checkpoint;
          }
        }
        throw new Error("not found");
      };

      const agy = new ScriptedHost("agy", [
        async (input) => {
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "mid";\n');
          return {
            host: "agy",
            outcome: "capacity_unavailable",
            exitCode: 1,
            usage: null,
            completedCriteria: [],
            remainingCriteria: ["Continue privately"]
          };
        }
      ]);

      await runContributionSession({
        engine,
        coordinator,
        host: agy,
        sessionId: description.sessionId,
        policy,
        policyDigest: description.policyDigest,
        acquireRepository: async (leased) => coordinator.resolveLocalRepository(leased)
      });

      expect(coordinator.getAcceptedCheckpoint("continue-task")).not.toBeNull();

      // Second session: Codex finishes from the accepted checkpoint.
      const codexPolicy = { ...policy, host: "codex" as const };
      const engine2 = new GenkiEngine({ stateRoot: await mkdtemp(path.join(os.tmpdir(), "genki-cont2-")) });
      const description2 = await engine2.describeSession({
        taskDirectory: queue,
        policy: codexPolicy
      });
      await engine2.activateSession(description2.sessionId, description2.policyDigest);
      const codex = new ScriptedHost("codex", [
        async (input) => {
          const current = await readFile(path.join(input.workspace, "value.js"), "utf8");
          expect(current).toContain("mid");
          await writeFile(path.join(input.workspace, "value.js"), 'export const value = "after";\n');
          return {
            host: "codex",
            outcome: "completed",
            exitCode: 0,
            usage: null,
            completedCriteria: ["Continue privately"],
            remainingCriteria: []
          };
        }
      ]);

      await runContributionSession({
        engine: engine2,
        coordinator,
        host: codex,
        sessionId: description2.sessionId,
        policy: codexPolicy,
        policyDigest: description2.policyDigest,
        acquireRepository: async (leased) => coordinator.resolveLocalRepository(leased)
      });

      const results = coordinator.listOperations().filter((op) => op.kind === "result");
      expect(results).toHaveLength(1);
      expect(agy.conversationIds[0]).not.toEqual(codex.conversationIds[0]);
      expect(await readFile(path.join(repository, "value.js"), "utf8")).toContain("before");
    },
    60_000
  );
});
