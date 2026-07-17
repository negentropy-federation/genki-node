import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { cleanupSession } from "../../packages/core/src/cleanup.js";
import { GenkiEngine } from "../../packages/core/src/engine.js";
import type { SessionPolicy, TaskDefinition } from "../../packages/core/src/types.js";

const execFileAsync = promisify(execFile);
const seededSecret = "genki-secret-must-disappear";
const seededTaskText = "genki-task-text-must-disappear";

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

describe("privacy lifecycle", () => {
  it("does not inherit a seeded secret and removes task text during cleanup", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-privacy-state-"));
    const queue = await mkdtemp(path.join(os.tmpdir(), "genki-privacy-queue-"));
    const repository = await mkdtemp(path.join(os.tmpdir(), "genki-privacy-repository-"));
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Genki Test");
    await git(repository, "config", "user.email", "genki@example.invalid");
    await writeFile(path.join(repository, "value.txt"), "unchanged\n");
    await git(repository, "add", "value.txt");
    await git(repository, "commit", "-m", "initial");

    const task: TaskDefinition = {
      schemaVersion: "1",
      id: "privacy-task",
      title: seededTaskText,
      repository: { path: repository, baseRef: "HEAD" },
      instructions: seededTaskText,
      validation: [
        {
          argv: [
            "node",
            "-e",
            "process.stdout.write(process.env.GENKI_TEST_SECRET ?? 'absent')"
          ],
          timeoutSeconds: 10
        }
      ],
      policy: { maxRuntimeSeconds: 30, maxChangedFiles: 5, maxPatchBytes: 10_000 }
    };
    await writeFile(path.join(queue, "01-privacy.json"), JSON.stringify(task));
    const policy: SessionPolicy = {
      schemaVersion: "1",
      durationSeconds: 3600,
      maxTasks: 1,
      maxTotalRuntimeSeconds: 600,
      maxTaskRuntimeSeconds: 60,
      maxChangedFiles: 5,
      maxPatchBytes: 10_000,
      allowedExecutables: ["node"],
      host: "agy",
      model: null,
      retainUntilVerified: true
    };
    const ids = ["privacy-session", "privacy-run", "privacy-attempt", "privacy-lease"];
    const engine = new GenkiEngine({ stateRoot, createId: () => ids.shift() ?? "unexpected" });
    process.env.GENKI_TEST_SECRET = seededSecret;

    try {
      const description = await engine.describeSession({ taskDirectory: queue, policy });
      await engine.activateSession(description.sessionId, description.policyDigest);
      const prepared = await engine.prepareNextTask(description.sessionId);
      const validation = await engine.runValidation(prepared!.runId);
      expect(validation.commands[0]?.stdout).toBe("absent");
      await engine.finalizeAndDeliver(prepared!.runId);
      expect(await allFileText(description.sessionRoot)).not.toContain(seededSecret);
      await cleanupSession(stateRoot, description.sessionId);
    } finally {
      delete process.env.GENKI_TEST_SECRET;
    }

    expect(await allFileText(stateRoot)).not.toContain(seededSecret);
    expect(await allFileText(stateRoot)).not.toContain(seededTaskText);
    expect(await readFile(path.join(repository, "value.txt"), "utf8")).toBe("unchanged\n");
  });
});
