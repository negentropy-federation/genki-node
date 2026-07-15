import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runValidationCommands } from "./validation.js";

async function validationContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), "genki-validation-"));
  return {
    cwd: root,
    environment: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: root,
      CI: "1"
    }
  };
}

describe("runValidationCommands", () => {
  it("passes arguments directly without shell expansion", async () => {
    const context = await validationContext();
    const summary = await runValidationCommands({
      ...context,
      commands: [
        {
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(process.argv[1])",
            "$(echo should-not-run)"
          ],
          timeoutSeconds: 5
        }
      ],
      maxTotalRuntimeSeconds: 10,
      outputLimitBytes: 1024
    });

    expect(summary.passed).toBe(true);
    expect(summary.commands[0]?.stdout).toBe("$(echo should-not-run)");
  });

  it("terminates a command at its timeout", async () => {
    const context = await validationContext();
    const summary = await runValidationCommands({
      ...context,
      commands: [
        {
          argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
          timeoutSeconds: 0.05
        }
      ],
      maxTotalRuntimeSeconds: 1,
      outputLimitBytes: 1024
    });

    expect(summary.passed).toBe(false);
    expect(summary.commands[0]?.timedOut).toBe(true);
  });

  it("bounds stdout and reports truncation", async () => {
    const context = await validationContext();
    const summary = await runValidationCommands({
      ...context,
      commands: [
        {
          argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1024))"],
          timeoutSeconds: 5
        }
      ],
      maxTotalRuntimeSeconds: 10,
      outputLimitBytes: 64
    });

    expect(Buffer.byteLength(summary.commands[0]?.stdout ?? "")).toBe(64);
    expect(summary.commands[0]?.stdoutTruncated).toBe(true);
  });
});
