import path from "node:path";
import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("parses contribution defaults", () => {
    const taskDirectory = path.resolve("local-queue");
    expect(parseCliArgs(["contribute", "--task-dir", taskDirectory])).toEqual({
      command: "contribute",
      taskDirectory,
      coordinator: { kind: "local" },
      policy: {
        schemaVersion: "1",
        durationSeconds: 28_800,
        maxTasks: 10,
        maxTotalRuntimeSeconds: 7_200,
        maxTaskRuntimeSeconds: 900,
        maxChangedFiles: 20,
        maxPatchBytes: 200_000,
        allowedExecutables: ["node", "npm"],
        host: "agy",
        model: null,
        retainUntilVerified: false
      }
    });
  });

  it("parses local and HTTPS coordinator targets", () => {
    expect(
      parseCliArgs([
        "contribute",
        "--task-dir",
        "/tmp/tasks",
        "--coordinator",
        "local"
      ])
    ).toMatchObject({ coordinator: { kind: "local" } });
    expect(
      parseCliArgs([
        "contribute",
        "--task-dir",
        "/tmp/tasks",
        "--coordinator",
        "https://coordinator.example.com"
      ])
    ).toMatchObject({
      coordinator: { kind: "http", url: "https://coordinator.example.com" }
    });
    expect(() =>
      parseCliArgs([
        "contribute",
        "--task-dir",
        "/tmp/tasks",
        "--coordinator",
        "http://example.com"
      ])
    ).toThrow(/HTTPS/iu);
  });

  it("parses explicit bounded contribution options", () => {
    const result = parseCliArgs([
      "contribute",
      "--task-dir",
      "/tmp/tasks",
      "--duration",
      "30m",
      "--max-tasks",
      "2",
      "--max-total-runtime",
      "10m",
      "--max-task-runtime",
      "5m",
      "--allow",
      "node,git",
      "--model",
      "Gemini 3.5 Flash (Low)",
      "--retain-until-verified"
    ]);

    expect(result).toMatchObject({
      command: "contribute",
      policy: {
        durationSeconds: 1800,
        maxTasks: 2,
        maxTotalRuntimeSeconds: 600,
        maxTaskRuntimeSeconds: 300,
        allowedExecutables: ["node", "git"],
        model: "Gemini 3.5 Flash (Low)",
        retainUntilVerified: true
      }
    });
  });

  it.each(["agy", "codex"] as const)("parses --host %s", (host) => {
    expect(
      parseCliArgs(["contribute", "--task-dir", "/tmp/tasks", "--host", host])
    ).toMatchObject({
      command: "contribute",
      policy: { host }
    });
  });

  it("rejects unknown hosts", () => {
    expect(() =>
      parseCliArgs(["contribute", "--task-dir", "/tmp/tasks", "--host", "claude"])
    ).toThrowError(/--host must be agy or codex/iu);
  });

  it.each([
    [["contribute"], "--task-dir"],
    [["contribute", "--task-dir", "/tmp/tasks", "--duration", "forever"], "duration"],
    [["unknown"], "Unknown command"]
  ] as const)("rejects invalid argv %j", (argv, message) => {
    expect(() => parseCliArgs([...argv])).toThrowError(new RegExp(message, "iu"));
  });

  it("parses status, stop, and cleanup commands", () => {
    expect(parseCliArgs(["status", "session-1"])).toEqual({
      command: "status",
      sessionId: "session-1"
    });
    expect(parseCliArgs(["stop", "session-1"])).toEqual({
      command: "stop",
      sessionId: "session-1"
    });
    expect(parseCliArgs(["cleanup", "--session", "session-1"])).toEqual({
      command: "cleanup-session",
      sessionId: "session-1"
    });
    expect(parseCliArgs(["cleanup", "--all-expired"])).toEqual({
      command: "cleanup-expired"
    });
  });

  it("uses a typed usage error", () => {
    expect(() => parseCliArgs([])).toThrow(CliUsageError);
  });
});
