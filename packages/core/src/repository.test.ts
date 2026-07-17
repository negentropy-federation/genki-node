import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { applyCheckpoint, buildPatch, cloneRepository, inspectRepository } from "./repository.js";
import type { PartialCheckpoint, TaskDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "genki-repository-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Genki Test");
  await git(repository, "config", "user.email", "genki@example.invalid");
  await writeFile(path.join(repository, "value.txt"), "before\n");
  await git(repository, "add", "value.txt");
  await git(repository, "commit", "-m", "initial");
  return repository;
}

function taskFor(repository: string): TaskDefinition {
  return {
    schemaVersion: "1",
    id: "repository-test",
    title: "Repository test",
    repository: { path: repository, baseRef: "HEAD" },
    instructions: "Change the fixture.",
    validation: [{ argv: [process.execPath, "--version"], timeoutSeconds: 5 }],
    policy: { maxRuntimeSeconds: 30, maxChangedFiles: 5, maxPatchBytes: 10_000 }
  };
}

const gitTestTimeoutMs = 30_000;

describe("inspectRepository", () => {
  it(
    "resolves a clean local repository to a commit",
    async () => {
      const repository = await createRepository();
      const inspection = await inspectRepository(taskFor(repository));

      expect(inspection.sourcePath).toBe(repository);
      expect(inspection.baseCommit).toMatch(/^[0-9a-f]{40}$/u);
    },
    gitTestTimeoutMs
  );

  it(
    "rejects dirty repositories",
    async () => {
      const repository = await createRepository();
      await writeFile(path.join(repository, "value.txt"), "dirty\n");

      await expect(inspectRepository(taskFor(repository))).rejects.toThrow("clean");
    },
    gitTestTimeoutMs
  );

  it(
    "rejects configured submodules",
    async () => {
      const repository = await createRepository();
      await writeFile(
        path.join(repository, ".gitmodules"),
        '[submodule "outside"]\n\tpath = outside\n\turl = ../outside\n'
      );
      await git(repository, "add", ".gitmodules");
      await git(repository, "commit", "-m", "add submodule config");

      await expect(inspectRepository(taskFor(repository))).rejects.toThrow("submodule");
    },
    gitTestTimeoutMs
  );

  it(
    "rejects tracked symlinks that escape the repository",
    async () => {
      const repository = await createRepository();
      await symlink("../outside-secret", path.join(repository, "escape"));
      await git(repository, "add", "escape");
      await git(repository, "commit", "-m", "add escaping symlink");

      await expect(inspectRepository(taskFor(repository))).rejects.toThrow("symlink");
    },
    gitTestTimeoutMs
  );
});

describe("cloneRepository and buildPatch", () => {
  it(
    "isolates changes from source contents and refs",
    async () => {
      const repository = await createRepository();
      const sourceHead = await git(repository, "rev-parse", "HEAD");
      const destinationParent = await mkdtemp(path.join(os.tmpdir(), "genki-clone-"));
      const destination = path.join(destinationParent, "workspace");
      const inspection = await inspectRepository(taskFor(repository));

      await cloneRepository(inspection, destination);
      await writeFile(path.join(destination, "value.txt"), "after\n");
      const patch = await buildPatch(destination);

      expect(patch.changedFiles).toEqual(["value.txt"]);
      expect(patch.patch).toContain("+after");
      expect(patch.patchBytes).toBeGreaterThan(0);
      expect(patch.patchDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(await readFile(path.join(repository, "value.txt"), "utf8")).toBe("before\n");
      expect(await git(repository, "rev-parse", "HEAD")).toBe(sourceHead);
      expect(await git(destination, "rev-parse", "--git-dir")).toBe(".git");
    },
    gitTestTimeoutMs
  );

  it(
    "includes newly created files in the patch",
    async () => {
      const repository = await createRepository();
      const destinationParent = await mkdtemp(path.join(os.tmpdir(), "genki-clone-"));
      const destination = path.join(destinationParent, "workspace");
      const inspection = await inspectRepository(taskFor(repository));

      await cloneRepository(inspection, destination);
      await writeFile(path.join(destination, "created.txt"), "new content\n");
      const patch = await buildPatch(destination);

      expect(patch.changedFiles).toEqual(["created.txt"]);
      expect(patch.patch).toContain("created.txt");
      expect(patch.patch).toContain("+new content");
    },
    gitTestTimeoutMs
  );
});

describe("applyCheckpoint", () => {
  async function checkpointFromEdit(
    repository: string,
    relativeFile: string,
    contents: string
  ): Promise<{ checkpoint: PartialCheckpoint; baseCommit: string }> {
    const inspection = await inspectRepository(taskFor(repository));
    const parent = await mkdtemp(path.join(os.tmpdir(), "genki-apply-src-"));
    const workspace = path.join(parent, "workspace");
    await cloneRepository(inspection, workspace);
    await writeFile(path.join(workspace, relativeFile), contents);
    const patch = await buildPatch(workspace);
    return {
      baseCommit: inspection.baseCommit,
      checkpoint: {
        schemaVersion: "1",
        taskId: "apply-task",
        taskRevision: 1,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        leaseGeneration: 1,
        baseCommit: inspection.baseCommit,
        patch: patch.patch,
        patchDigest: patch.patchDigest,
        changedFiles: patch.changedFiles,
        validation: null,
        host: "codex",
        hostOutcome: "capacity_unavailable",
        completedCriteria: [],
        remainingCriteria: [],
        createdAt: "2026-07-16T00:00:00.000Z"
      }
    };
  }

  it(
    "applies a clean checkpoint only to the declared base commit",
    async () => {
      const repository = await createRepository();
      const { checkpoint } = await checkpointFromEdit(repository, "value.txt", "after\n");
      const parent = await mkdtemp(path.join(os.tmpdir(), "genki-apply-dst-"));
      const workspace = path.join(parent, "workspace");
      await cloneRepository(await inspectRepository(taskFor(repository)), workspace);

      await applyCheckpoint(workspace, checkpoint);
      await expect(readFile(path.join(workspace, "value.txt"), "utf8")).resolves.toBe("after\n");
    },
    gitTestTimeoutMs
  );

  it(
    "rejects checkpoints whose base commit does not match the workspace",
    async () => {
      const repository = await createRepository();
      const { checkpoint } = await checkpointFromEdit(repository, "value.txt", "after\n");
      const parent = await mkdtemp(path.join(os.tmpdir(), "genki-apply-wrong-"));
      const workspace = path.join(parent, "workspace");
      await cloneRepository(await inspectRepository(taskFor(repository)), workspace);

      await expect(
        applyCheckpoint(workspace, { ...checkpoint, baseCommit: "0".repeat(40) })
      ).rejects.toThrow(/base commit/i);
    },
    gitTestTimeoutMs
  );

  it(
    "rejects patches with absolute paths, parent traversal, or binary payloads",
    async () => {
      const repository = await createRepository();
      const inspection = await inspectRepository(taskFor(repository));
      const parent = await mkdtemp(path.join(os.tmpdir(), "genki-apply-bad-"));
      const workspace = path.join(parent, "workspace");
      await cloneRepository(inspection, workspace);

      const base = {
        schemaVersion: "1" as const,
        taskId: "apply-task",
        taskRevision: 1,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        leaseGeneration: 1,
        baseCommit: inspection.baseCommit,
        patchDigest: "a".repeat(64),
        changedFiles: ["value.txt"],
        validation: null,
        host: "codex" as const,
        hostOutcome: "host_failed" as const,
        completedCriteria: [],
        remainingCriteria: [],
        createdAt: "2026-07-16T00:00:00.000Z"
      };

      await expect(
        applyCheckpoint(workspace, {
          ...base,
          patch:
            "diff --git a/../escape.txt b/../escape.txt\n--- a/../escape.txt\n+++ b/../escape.txt\n"
        })
      ).rejects.toThrow(/path/i);

      await expect(
        applyCheckpoint(workspace, {
          ...base,
          patch: "diff --git a//tmp/escape.txt b//tmp/escape.txt\n"
        })
      ).rejects.toThrow(/path/i);

      await expect(
        applyCheckpoint(workspace, {
          ...base,
          patch: "diff --git a/value.txt b/value.txt\nGIT binary patch\nliteral 0\nHcmV?d00001\n"
        })
      ).rejects.toThrow(/binary/i);
    },
    gitTestTimeoutMs
  );
});
