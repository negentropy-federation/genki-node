import { describe, expect, it } from "vitest";
import { acquireRepository } from "./repository-source.js";
import type { LeasedTask, SessionPolicy } from "./types.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";

describe("acquireRepository", () => {
  const policy: SessionPolicy = {
    schemaVersion: "1",
    durationSeconds: 3600,
    maxTasks: 1,
    maxTotalRuntimeSeconds: 3600,
    maxTaskRuntimeSeconds: 3600,
    maxChangedFiles: 5,
    maxPatchBytes: 1000,
    allowedExecutables: [],
    allowedRepositoryClasses: ["public"],
    host: "codex",
    model: null,
    retainUntilVerified: false
  };

  const taskTemplate: LeasedTask = {
    schemaVersion: "2",
    taskId: "test-task",
    revision: 1,
    leaseId: "lease-1",
    leaseGeneration: 1,
    leaseExpiresAt: "2099-01-01T00:00:00Z",
    project: {
      projectId: "test",
      repositoryUrl: "",
      repositoryClass: "public",
      licenseSpdx: "Apache-2.0",
      baseCommit: "0000000000000000000000000000000000000000"
    },
    goal: "test",
    acceptanceCriteria: [],
    validation: [],
    policy: {
      maxRuntimeSeconds: 900,
      maxChangedFiles: 5,
      maxPatchBytes: 1000,
      dependencyDomains: [],
      executionNetwork: "none"
    },
    predecessorCheckpoint: null
  };

  it("rejects URLs with credentials (userinfo)", async () => {
    const task = {
      ...taskTemplate,
      project: {
        ...taskTemplate.project,
        repositoryUrl: "https://user:pass@github.com/test/repo.git"
      }
    };
    await expect(acquireRepository(task, policy, os.tmpdir())).rejects.toThrow(
      "Repository URL must not contain credentials"
    );
  });

  it("allows private repository if policy permits", async () => {
    const task = {
      ...taskTemplate,
      project: {
        ...taskTemplate.project,
        repositoryUrl: "https://github.com/test/repo.git",
        repositoryClass: "first_party_private" as const
      }
    };
    const relaxedPolicy = {
      ...policy,
      allowedRepositoryClasses: ["public", "first_party_private"] as ("public" | "first_party_private")[]
    };
    // Should fail at git clone, not at validation
    await expect(acquireRepository(task, relaxedPolicy, os.tmpdir())).rejects.toThrow(
      "Failed to acquire repository"
    );
  }, 10_000);

  it("acquires local public Git fixture successfully", async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "genki-fixture-"));
    await fs.mkdir(path.join(fixtureDir, ".git"), { recursive: true });
    // Needs to be a valid git repo to clone. Let's initialize a real git repo.
    execSync("git init -b main", { cwd: fixtureDir });
    execSync("git config user.name Test", { cwd: fixtureDir });
    execSync("git config user.email test@test", { cwd: fixtureDir });
    await fs.writeFile(path.join(fixtureDir, "test.txt"), "hello");
    execSync("git add test.txt", { cwd: fixtureDir });
    execSync("git commit -m 'init'", { cwd: fixtureDir });

    const task = {
      ...taskTemplate,
      project: {
        ...taskTemplate.project,
        repositoryUrl: `file://${fixtureDir}`
      }
    };
    
    const acquiredPath = await acquireRepository(task, policy, path.join(os.tmpdir(), "genki-test-clones"));
    expect(acquiredPath).toBeTruthy();
  });
});
