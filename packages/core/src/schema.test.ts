import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseLeasedTask,
  parsePartialCheckpoint,
  parseSessionPolicy,
  parseTaskDefinition
} from "./schema.js";
import {
  ACCEPTED_SPDX_LICENSES,
  type LeasedTask,
  type PartialCheckpoint,
  type SessionPolicy
} from "./types.js";

const validPolicy: SessionPolicy = {
  schemaVersion: "1",
  durationSeconds: 28_800,
  maxTasks: 10,
  maxTotalRuntimeSeconds: 7_200,
  maxTaskRuntimeSeconds: 900,
  maxChangedFiles: 20,
  maxPatchBytes: 200_000,
  allowedExecutables: ["npm", "node"],
  host: "agy",
  model: null,
  retainUntilVerified: false
};

const validTask = {
  schemaVersion: "1",
  id: "local-smoke-001",
  title: "Fix the parser",
  repository: {
    path: path.resolve("fixture-repository"),
    baseRef: "HEAD"
  },
  instructions: "Fix the parser without changing its public API.",
  validation: [{ argv: ["npm", "test"], timeoutSeconds: 300 }],
  policy: {
    maxRuntimeSeconds: 900,
    maxChangedFiles: 20,
    maxPatchBytes: 200_000
  }
};

const codexPolicy: SessionPolicy = {
  ...validPolicy,
  host: "codex"
};

const leasedTask: LeasedTask = {
  schemaVersion: "2",
  taskId: "parser-fix",
  revision: 1,
  leaseId: "lease-1",
  leaseGeneration: 1,
  leaseExpiresAt: "2026-07-16T12:00:00.000Z",
  project: {
    projectId: "federation-os",
    repositoryUrl: "https://github.com/negentropy-federation/os-lab.git",
    repositoryClass: "public",
    licenseSpdx: "Apache-2.0",
    baseCommit: "0123456789012345678901234567890123456789"
  },
  goal: "Fix the parser without changing its public API.",
  acceptanceCriteria: ["The parser regression test passes."],
  validation: [{ argv: ["npm", "test"], timeoutSeconds: 300 }],
  policy: {
    maxRuntimeSeconds: 900,
    maxChangedFiles: 5,
    maxPatchBytes: 200_000,
    executionNetwork: "none",
    dependencyDomains: []
  },
  predecessorCheckpoint: null
};

const partialCheckpoint: PartialCheckpoint = {
  schemaVersion: "1",
  taskId: "parser-fix",
  taskRevision: 1,
  attemptId: "attempt-1",
  leaseId: "lease-1",
  leaseGeneration: 1,
  baseCommit: "0123456789012345678901234567890123456789",
  patch: "diff --git a/parser.ts b/parser.ts\n",
  patchDigest: "a".repeat(64),
  changedFiles: ["parser.ts"],
  validation: {
    passed: true,
    commands: [{ executable: "npm", exitCode: 0, timedOut: false, durationMs: 25 }],
    durationMs: 25
  },
  host: "codex",
  hostOutcome: "completed",
  completedCriteria: ["The parser regression test passes."],
  remainingCriteria: [],
  createdAt: "2026-07-16T01:00:00.000Z"
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSessionPolicy", () => {
  it("accepts a bounded Agy contribution policy", () => {
    expect(parseSessionPolicy(validPolicy)).toEqual(validPolicy);
  });

  it("rejects unsupported schema versions and nonpositive limits", () => {
    expect(() => parseSessionPolicy({ ...validPolicy, schemaVersion: "2" })).toThrow();
    expect(() => parseSessionPolicy({ ...validPolicy, maxTasks: 0 })).toThrow();
  });

  it("rejects shell fragments as executable names", () => {
    expect(() =>
      parseSessionPolicy({ ...validPolicy, allowedExecutables: ["npm && curl"] })
    ).toThrow();
  });

  it("accepts Codex and rejects unknown hosts", () => {
    expect(parseSessionPolicy(codexPolicy)).toEqual(codexPolicy);
    expect(() => parseSessionPolicy({ ...validPolicy, host: "claude" })).toThrow();
  });
});

describe("parseTaskDefinition", () => {
  it("accepts a versioned local task with argv validation", () => {
    expect(parseTaskDefinition(validTask)).toEqual(validTask);
  });

  it("rejects relative repositories and shell-string commands", () => {
    expect(() =>
      parseTaskDefinition({
        ...validTask,
        repository: { ...validTask.repository, path: "relative/repository" }
      })
    ).toThrow();
    expect(() =>
      parseTaskDefinition({ ...validTask, validation: [{ argv: "npm test", timeoutSeconds: 30 }] })
    ).toThrow();
  });

  it("rejects validation executable paths that bypass the session allowlist", () => {
    expect(() =>
      parseTaskDefinition({
        ...validTask,
        validation: [{ argv: ["/tmp/fake-node", "--test"], timeoutSeconds: 30 }]
      })
    ).toThrow();
  });

  it("rejects oversized instructions and invalid task IDs", () => {
    expect(() => parseTaskDefinition({ ...validTask, id: "not allowed" })).toThrow();
    expect(() => parseTaskDefinition({ ...validTask, instructions: "x".repeat(20_001) })).toThrow();
  });
});

describe("parseLeasedTask", () => {
  it("accepts a strict version 2 leased task", () => {
    expect(parseLeasedTask(leasedTask)).toEqual(leasedTask);
  });

  it("exports the exact initial SPDX allowlist", () => {
    expect(ACCEPTED_SPDX_LICENSES).toEqual([
      "Apache-2.0",
      "MIT",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "MPL-2.0",
      "GPL-2.0-only",
      "GPL-2.0-or-later",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
      "LGPL-2.1-only",
      "LGPL-2.1-or-later",
      "LGPL-3.0-only",
      "LGPL-3.0-or-later"
    ]);
  });

  it("rejects unsafe repository, license, network, lease, and validation inputs", () => {
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        // @ts-expect-error Testing invalid repository class
        project: { ...leasedTask.project, repositoryClass: "private" }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, repositoryUrl: "http://example.com/repository.git" }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, baseCommit: "main" }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, licenseSpdx: "MIT OR Apache-2.0" }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        policy: { ...leasedTask.policy, executionNetwork: "full" }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({ ...leasedTask, leaseExpiresAt: "2025-07-16T12:00:00.000Z" })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        validation: [{ argv: "npm test", timeoutSeconds: 300 }]
      })
    ).toThrow();
  });

  it.each([
    "https://token@github.com/org/repo.git",
    "https://github.com/org/repo.git?token=x",
    "https://github.com/org/repo.git#main",
    "https://github.com/org/repo.git?",
    "https://github.com/org/repo.git#",
    "https://@github.com/org/repo.git",
    "https://:@github.com/org/repo.git",
    " https://@github.com/org/repo.git",
    "https:////:@github.com/org/repo.git",
    "https://",
    "https://github.com\\evil/repo.git",
    "https://github.com/org/repo.git ",
    "HTTPS://github.com/org/repo.git"
  ])("rejects noncanonical repository URL syntax: %s", (repositoryUrl) => {
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, repositoryUrl }
      })
    ).toThrow();
  });

  it.each([
    "https://-github.com/org/repo.git",
    "https://git_hub.com/org/repo.git",
    "https://localhost/org/repo.git"
  ])("rejects invalid repository hostname: %s", (repositoryUrl) => {
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, repositoryUrl }
      })
    ).toThrow();
  });

  it("allows @ in the repository path", () => {
    const repositoryUrl = "https://github.com/org/@scope-repo.git";

    expect(
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, repositoryUrl }
      }).project.repositoryUrl
    ).toBe(repositoryUrl);
  });

  it("validates checkpoint references and rejects unknown nested keys", () => {
    const predecessorCheckpoint = {
      checkpointId: "checkpoint-1",
      baseCommit: "0123456789012345678901234567890123456789",
      patchDigest: "b".repeat(64)
    };
    expect(parseLeasedTask({ ...leasedTask, predecessorCheckpoint })).toMatchObject({
      predecessorCheckpoint
    });

    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        predecessorCheckpoint: { ...predecessorCheckpoint, checkpointId: "../checkpoint" }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        predecessorCheckpoint: { ...predecessorCheckpoint, baseCommit: "A".repeat(40) }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        predecessorCheckpoint: { ...predecessorCheckpoint, patchDigest: "b".repeat(63) }
      })
    ).toThrow();
    expect(() =>
      parseLeasedTask({
        ...leasedTask,
        project: { ...leasedTask.project, unexpected: true }
      })
    ).toThrow();
  });
});

describe("parsePartialCheckpoint", () => {
  it("accepts a provider-neutral checkpoint with bounded validation", () => {
    expect(parsePartialCheckpoint(partialCheckpoint)).toEqual(partialCheckpoint);
  });

  it("enforces the checkpoint patch limit in UTF-8 bytes", () => {
    const maxPatchBytes = 5 * 1024 * 1024;
    const multibytePatch = "界".repeat(Math.floor(maxPatchBytes / 3) + 1);

    expect(multibytePatch.length).toBeLessThan(maxPatchBytes);
    expect(Buffer.byteLength(multibytePatch, "utf8")).toBeGreaterThan(maxPatchBytes);
    expect(() => parsePartialCheckpoint({ ...partialCheckpoint, patch: multibytePatch })).toThrow();
  });

  it("rejects unbounded or invalid validation summaries", () => {
    expect(() =>
      parsePartialCheckpoint({
        ...partialCheckpoint,
        validation: {
          ...partialCheckpoint.validation,
          commands: [
            {
              executable: "npm",
              exitCode: 0,
              timedOut: false,
              durationMs: 25,
              stdout: "raw output"
            }
          ]
        }
      })
    ).toThrow();
    expect(() =>
      parsePartialCheckpoint({
        ...partialCheckpoint,
        validation: {
          passed: false,
          commands: [{ executable: "npm test", exitCode: 256, timedOut: false, durationMs: -1 }],
          durationMs: -1
        }
      })
    ).toThrow();
    expect(() =>
      parsePartialCheckpoint({
        ...partialCheckpoint,
        validation: {
          passed: true,
          commands: Array.from({ length: 17 }, () => ({
            executable: "npm",
            exitCode: null,
            timedOut: true,
            durationMs: 0
          })),
          durationMs: 0
        }
      })
    ).toThrow();
  });

  it("rejects malformed digests, timestamps, hosts, outcomes, and unknown keys", () => {
    expect(() =>
      parsePartialCheckpoint({ ...partialCheckpoint, patchDigest: "A".repeat(64) })
    ).toThrow();
    expect(() => parsePartialCheckpoint({ ...partialCheckpoint, createdAt: "today" })).toThrow();
    expect(() => parsePartialCheckpoint({ ...partialCheckpoint, host: "claude" })).toThrow();
    expect(() => parsePartialCheckpoint({ ...partialCheckpoint, hostOutcome: "unknown" })).toThrow();
    expect(() => parsePartialCheckpoint({ ...partialCheckpoint, unexpected: true })).toThrow();
  });
});
