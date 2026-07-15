import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { AgyLaunchError, buildAgyArgs, runAgy } from "./agy.js";

describe("Agy launch", () => {
  it("builds a sandboxed generic interactive session", () => {
    const args = buildAgyArgs({
      sessionId: "session-1",
      sessionRoot: "/tmp/genki/session-1",
      agyLogPath: "/tmp/genki/session-1/agy.log",
      model: null
    });

    expect(args).toEqual([
      "--sandbox",
      "--new-project",
      "--add-dir",
      "/tmp/genki/session-1",
      "--log-file",
      "/tmp/genki/session-1/agy.log",
      "--prompt-interactive",
      "Continue the active Genki contribution session session-1 using the genki-contribution skill."
    ]);
    expect(JSON.stringify(args)).not.toContain("task instructions");
    expect(JSON.stringify(args)).not.toContain("repository");
  });

  it("adds an explicit model when configured", () => {
    expect(
      buildAgyArgs({
        sessionId: "session-1",
        sessionRoot: "/tmp/session",
        agyLogPath: "/tmp/session/agy.log",
        model: "Gemini 3.5 Flash (Low)"
      })
    ).toContain("Gemini 3.5 Flash (Low)");
  });

  it("reports a missing Agy executable without hanging", async () => {
    await expect(
      runAgy({
        command: "definitely-missing-agy-command",
        args: [],
        environment: {},
        stdio: "ignore"
      })
    ).rejects.toThrow(AgyLaunchError);
  });

  it("forwards Ctrl-C to Agy and resolves before local cleanup", async () => {
    const signals = new EventEmitter();
    const input = {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 200)"],
      environment: process.env,
      stdio: "ignore" as const,
      signalSource: signals
    } as unknown as Parameters<typeof runAgy>[0];
    const running = runAgy(input);
    await new Promise((resolve) => setTimeout(resolve, 20));

    signals.emit("SIGINT");

    await expect(running).resolves.toBe(130);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
