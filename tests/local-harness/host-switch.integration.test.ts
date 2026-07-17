import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { LocalCoordinator } from "../../packages/coordinator/src/local.js";
import { GenkiEngine } from "../../packages/core/src/engine.js";
import type { SessionPolicy, TaskDefinition } from "../../packages/core/src/types.js";
import { AgyHostAdapter } from "../../packages/hosts/src/agy.js";
import { CodexHostAdapter } from "../../packages/hosts/src/codex.js";

const execFileAsync = promisify(execFile);
const fakeAgy = fileURLToPath(new URL("../fake-hosts/fake-agy.mjs", import.meta.url));
const fakeCodex = fileURLToPath(new URL("../fake-hosts/fake-codex.mjs", import.meta.url));

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("host adapter isolation", () => {
  it(
    "keeps seeded secrets out of fake Agy and Codex child environments",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "genki-host-switch-"));
      const runRoot = path.join(root, "run");
      const workspace = path.join(runRoot, "workspace");
      const home = path.join(runRoot, "home");
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true });

      const agentSocket = path.join(root, "ssh-agent.sock");
      const cloudCreds = path.join(root, "cloud.json");
      await writeFile(agentSocket, "socket");
      await writeFile(cloudCreds, JSON.stringify({ key: "cloud-secret-must-disappear" }));
      await writeFile(path.join(root, "notes.txt"), "sibling-secret-must-disappear");
      await writeFile(path.join(workspace, "value.js"), "export const value = 1;\n");
      await writeFile(path.join(workspace, ".fake-codex-mode"), "success");
      await writeFile(path.join(workspace, ".fake-agy-mode"), "success");

      const parentEnvironment: NodeJS.ProcessEnv = {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(root, "native-home"),
        GENKI_TEST_SECRET: "genki-secret-must-disappear",
        SSH_AUTH_SOCK: agentSocket,
        AWS_SECRET_ACCESS_KEY: "aws-secret-must-disappear",
        OPENAI_API_KEY: "openai-secret-must-disappear"
      };

      const agy = new AgyHostAdapter({
        command: fakeAgy,
        parentEnvironment
      });
      const codex = new CodexHostAdapter({
        command: fakeCodex,
        parentEnvironment
      });

      const shared = {
        sessionId: "session-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        workspace,
        instructions: "genki-task-text-must-disappear",
        model: null,
        timeoutSeconds: 30,
        temporaryHome: home,
        abortSignal: new AbortController().signal
      };

      const agyResult = await agy.runTask(shared);
      const codexResult = await codex.runTask({ ...shared, attemptId: "attempt-2" });

      expect(["completed", "host_failed"]).toContain(agyResult.outcome);
      expect(codexResult.outcome).toBe("completed");
      expect(JSON.stringify(agyResult)).not.toContain("genki-secret-must-disappear");
      expect(JSON.stringify(codexResult)).not.toContain("openai-secret-must-disappear");
      expect(JSON.stringify(agyResult)).not.toContain("genki-task-text-must-disappear");
      expect(JSON.stringify(codexResult)).not.toContain("genki-task-text-must-disappear");

      const queue = await mkdtemp(path.join(os.tmpdir(), "genki-host-queue-"));
      const repository = await mkdtemp(path.join(os.tmpdir(), "genki-host-repo-"));
      await git(repository, "init", "-b", "main");
      await git(repository, "config", "user.name", "Genki Test");
      await git(repository, "config", "user.email", "genki@example.invalid");
      await writeFile(path.join(repository, "value.js"), "export const value = 1;\n");
      await git(repository, "add", ".");
      await git(repository, "commit", "-m", "initial");
      const task: TaskDefinition = {
        schemaVersion: "1",
        id: "host-switch-task",
        title: "title",
        repository: { path: repository, baseRef: "HEAD" },
        instructions: "instructions",
        validation: [{ argv: ["node", "--version"], timeoutSeconds: 10 }],
        policy: { maxRuntimeSeconds: 30, maxChangedFiles: 2, maxPatchBytes: 5_000 }
      };
      await writeFile(path.join(queue, "01.json"), JSON.stringify(task));
      const coordinator = new LocalCoordinator({ taskDirectory: queue });
      const policy: SessionPolicy = {
        schemaVersion: "1",
        durationSeconds: 600,
        maxTasks: 1,
        maxTotalRuntimeSeconds: 300,
        maxTaskRuntimeSeconds: 60,
        maxChangedFiles: 5,
        maxPatchBytes: 10_000,
        allowedExecutables: ["node"],
        host: "agy",
        model: null,
        retainUntilVerified: false
      };
      const engine = new GenkiEngine({
        stateRoot: await mkdtemp(path.join(os.tmpdir(), "genki-host-state-"))
      });
      const description = await engine.describeSession({ taskDirectory: queue, policy });
      expect(description.summary.host).toBe("agy");
      expect(coordinator).toBeTruthy();
    },
    30_000
  );
});
