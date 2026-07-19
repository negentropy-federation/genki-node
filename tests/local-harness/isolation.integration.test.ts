import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { cleanupSession } from "../../packages/core/src/cleanup.js";
import { GenkiEngine } from "../../packages/core/src/engine.js";
import { getSessionPaths, getTaskRunPaths } from "../../packages/core/src/storage.js";
import type { SessionPolicy, TaskDefinition } from "../../packages/core/src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function allFileText(root: string): Promise<string> {
  let combined = "";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      combined += await allFileText(target);
    } else if (entry.isFile()) {
      combined += await readFile(target, "utf8");
    }
  }
  return combined;
}

describe("source repository isolation", () => {
  it("prevents host visible path and detects contamination", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-isolation-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-isolation-queue-"));
    const repository = await mkdtemp(path.join(os.tmpdir(), "genki-isolation-repository-"));
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Genki Test");
    await git(repository, "config", "user.email", "genki@example.invalid");
    await writeFile(path.join(repository, "value.txt"), "unchanged\n");
    await git(repository, "add", "value.txt");
    await git(repository, "commit", "-m", "initial");

    const task: TaskDefinition = {
      schemaVersion: "1",
      id: "isolation-task",
      title: "isolation",
      repository: { path: repository, baseRef: "HEAD" },
      instructions: "test",
      validation: [
        {
          argv: ["node", "-v"],
          timeoutSeconds: 10
        }
      ],
      policy: { maxRuntimeSeconds: 30, maxChangedFiles: 5, maxPatchBytes: 10_000 }
    };
    await writeFile(path.join(queue, "01-isolation.json"), JSON.stringify(task));
    
    const task2: TaskDefinition = {
      ...task,
      id: "contamination-task",
    };
    await writeFile(path.join(queue, "02-contamination.json"), JSON.stringify(task2));

    const policy: SessionPolicy = {
      schemaVersion: "1",
      durationSeconds: 3600,
      maxTasks: 2,
      maxTotalRuntimeSeconds: 600,
      maxTaskRuntimeSeconds: 60,
      maxChangedFiles: 5,
      maxPatchBytes: 10_000,
      allowedExecutables: ["node"],
  allowedRepositoryClasses: ["public"],
      host: "agy",
      model: null,
      retainUntilVerified: true
    };
    const ids = ["isolation-session", "run-1", "attempt-1", "lease-1", "run-2", "attempt-2", "lease-2"];
    const engine = new GenkiEngine({ stateRoot, createId: () => ids.shift() ?? "unexpected" });

    const description = await engine.describeSession({ taskDirectory: queue, policy });
    await engine.activateSession(description.sessionId, description.policyDigest);
    
    // Test 1: No absolute source path under host-visible tree
    const prepared = await engine.prepareNextTask(description.sessionId);
    const sessionPaths = getSessionPaths(stateRoot, description.sessionId);
    const runPaths = getTaskRunPaths(sessionPaths, prepared!.runId);
    
    expect(await allFileText(sessionPaths.workspacesRoot)).not.toContain(repository);
    expect(await allFileText(sessionPaths.homesRoot)).not.toContain(repository);
    expect(await allFileText(runPaths.root)).toContain(repository); // Meta contains it in run.json
    const taskJson = JSON.parse(await readFile(path.join(runPaths.root, "task.json"), "utf8"));
    expect(taskJson.repository.path).toBe("/REDACTED"); // properly redacted

    // Test 2 & 4: Happy path / Clone independence
    await writeFile(path.join(prepared!.workspace, "value.txt"), "modified in workspace\n");
    await engine.runValidation(prepared!.runId);
    const result = await engine.materializeResult(prepared!.runId);
    expect(result.outcome.code).toBe("DELIVERED");
    expect(result.outcome.passed).toBe(true);
    expect(await readFile(path.join(repository, "value.txt"), "utf8")).toBe("unchanged\n");

    // Test 3: Contamination
    const prepared2 = await engine.prepareNextTask(description.sessionId);
    await writeFile(path.join(repository, "value.txt"), "contaminated\n");
    await engine.runValidation(prepared2!.runId);
    const result2 = await engine.materializeResult(prepared2!.runId);
    expect(result2.outcome.code).toBe("SOURCE_CONTAMINATION");
    expect(result2.outcome.passed).toBe(false);

    await cleanupSession(stateRoot, description.sessionId);
  });
});
