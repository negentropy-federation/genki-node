import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseSessionPolicy, parseTaskDefinition } from "./schema.js";

const validPolicy = {
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
