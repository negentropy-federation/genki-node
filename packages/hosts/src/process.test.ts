import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runHostProcess } from "./process.js";
import type { HostProcessInput } from "./types.js";

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const fixtureSource = String.raw`
import { writeFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "arguments":
    process.stdout.write(JSON.stringify(args));
    break;
  case "environment":
    process.stdout.write(JSON.stringify(process.env));
    break;
  case "exit":
    process.stderr.write("ordinary failure");
    process.exit(Number(args[0]));
    break;
  case "ignore-term":
    process.on("SIGTERM", () => {
      process.stdout.write("SIGTERM\n");
      if (args[1]) writeFileSync(args[1], String(Date.now()));
    });
    writeFileSync(args[0], "ready");
    setInterval(() => {}, 1_000);
    break;
  case "ignore-term-until-exit":
    process.on("SIGTERM", () => process.stdout.write("SIGTERM\n"));
    writeFileSync(args[0], "ready");
    setTimeout(() => process.exit(0), Number(args[1]));
    setInterval(() => {}, 1_000);
    break;
  case "exit-on-term":
    process.on("SIGTERM", () => {
      process.stdout.write("SIGTERM\n", () => process.exit(0));
    });
    writeFileSync(args[0], "ready");
    setInterval(() => {}, 1_000);
    break;
  case "output":
    process.stdout.write("o".repeat(Number(args[0])));
    process.stderr.write("e".repeat(Number(args[1])));
    break;
  case "raw-output":
    process.stdout.write(Buffer.from(args[0], "hex"));
    process.stderr.write(Buffer.from(args[1], "hex"));
    break;
  case "stdin":
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => process.stdout.write(input));
    break;
  default:
    throw new Error("unknown fixture mode");
}
`;

let fixtureRoot: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "genki-host-process-"));
  fixturePath = path.join(fixtureRoot, "fixture.mjs");
  await writeFile(fixturePath, fixtureSource);
});

afterAll(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

function fixtureInput(mode: string, args: string[] = []): HostProcessInput {
  return {
    command: process.execPath,
    args: [fixturePath, mode, ...args],
    workingDirectory: fixtureRoot,
    environment: { PATH: process.env.PATH },
    timeoutMs: 5_000,
    abortSignal: new AbortController().signal
  };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Fixture did not become ready");
}

describe("runHostProcess", () => {
  it("passes argument arrays literally without shell interpretation", async () => {
    const literalArguments = ["$(printf injected)", "*.ts", "hello; exit 9"];

    const result = await runHostProcess(fixtureInput("arguments", literalArguments));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(literalArguments);
  });

  it("caps stdout and stderr at 256 KiB by default", async () => {
    const result = await runHostProcess(
      fixtureInput("output", [String(DEFAULT_OUTPUT_LIMIT + 17), String(DEFAULT_OUTPUT_LIMIT + 31)])
    );

    expect(Buffer.byteLength(result.stdout)).toBe(DEFAULT_OUTPUT_LIMIT);
    expect(Buffer.byteLength(result.stderr)).toBe(DEFAULT_OUTPUT_LIMIT);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("keeps malformed and incomplete UTF-8 output within each byte limit", async () => {
    const result = await runHostProcess({
      ...fixtureInput("raw-output", ["61c3", "61ff62"]),
      stdoutLimitBytes: 2,
      stderrLimitBytes: 3
    });

    expect(result.stdout).toBe("a");
    expect(result.stderr).toBe("a");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(3);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("uses the default 2,000 ms grace after a ready child receives timeout SIGTERM", async () => {
    const readyPath = path.join(fixtureRoot, "timeout-ready");
    const termPath = path.join(fixtureRoot, "timeout-term");

    const resultPromise = runHostProcess({
      ...fixtureInput("ignore-term", [readyPath, termPath]),
      timeoutMs: 500
    });
    await waitForFile(readyPath);
    await waitForFile(termPath);
    const termAt = Number(await readFile(termPath, "utf8"));
    const result = await resultPromise;
    const observedGraceMs = Date.now() - termAt;

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toContain("SIGTERM");
    expect(observedGraceMs).toBeGreaterThanOrEqual(1_800);
    expect(observedGraceMs).toBeLessThan(3_500);
  }, 6_000);

  it("latches abort when its child ignores SIGTERM until SIGKILL", async () => {
    const readyPath = path.join(fixtureRoot, "abort-ignore-ready");
    const termPath = path.join(fixtureRoot, "abort-ignore-term");
    const controller = new AbortController();
    const resultPromise = runHostProcess({
      ...fixtureInput("ignore-term", [readyPath, termPath]),
      abortSignal: controller.signal,
      timeoutMs: 1_000,
      terminateGraceMs: 1_200
    });
    await waitForFile(readyPath);

    const abortedAt = Date.now();
    controller.abort();
    await waitForFile(termPath);
    const result = await resultPromise;
    const shutdownMs = Date.now() - abortedAt;

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toContain("SIGTERM");
    expect(shutdownMs).toBeGreaterThanOrEqual(1_000);
    expect(shutdownMs).toBeLessThan(2_500);
  }, 4_000);

  it("latches timeout when abort fires during timeout escalation", async () => {
    const readyPath = path.join(fixtureRoot, "timeout-abort-ready");
    const termPath = path.join(fixtureRoot, "timeout-abort-term");
    const controller = new AbortController();
    const resultPromise = runHostProcess({
      ...fixtureInput("ignore-term", [readyPath, termPath]),
      abortSignal: controller.signal,
      timeoutMs: 300,
      terminateGraceMs: 150
    });
    await waitForFile(readyPath);
    await waitForFile(termPath);

    controller.abort();
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.signal).toBe("SIGKILL");
  });

  it("does not latch termination after natural exit while waiting for close", async () => {
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const kill = vi.fn(() => true);
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill
    });
    const child = fakeChild as unknown as ChildProcess;
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        fakeChild.exitCode = 0;
        child.emit("exit", 0, null);
        markExited();
      });
      return child;
    });

    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, spawn: spawnMock };
    });

    try {
      const { runHostProcess: runMockedHostProcess } = await import("./process.js");
      const resultPromise = runMockedHostProcess({
        ...fixtureInput("arguments"),
        command: "fake-host-command",
        abortSignal: controller.signal
      });
      await exited;

      controller.abort();
      stdout.end();
      stderr.end();
      child.emit("close", 0, null);
      const result = await resultPromise;

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("sends SIGTERM when its AbortSignal fires", async () => {
    const readyPath = path.join(fixtureRoot, "abort-ready");
    const controller = new AbortController();
    const resultPromise = runHostProcess({
      ...fixtureInput("exit-on-term", [readyPath]),
      abortSignal: controller.signal
    });
    await waitForFile(readyPath);

    controller.abort();
    const result = await resultPromise;

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("SIGTERM");
  });

  it("waits for close after a post-spawn error and preserves SIGKILL escalation", async () => {
    const readyPath = path.join(fixtureRoot, "post-spawn-error-ready");
    const originalKill = ChildProcess.prototype.kill;
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
      this: ChildProcess,
      signal?: number | NodeJS.Signals
    ) {
      if (signal === "SIGTERM") {
        this.emit("error", new Error("simulated failed kill notification"));
      }
      return originalKill.call(this, signal);
    });

    try {
      const resultPromise = runHostProcess({
        ...fixtureInput("ignore-term-until-exit", [readyPath, "750"]),
        timeoutMs: 300,
        terminateGraceMs: 100
      });
      await waitForFile(readyPath);

      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
      expect(result.signal).toBe("SIGKILL");
      expect(killSpy).toHaveBeenCalledWith("SIGKILL");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("returns ordinary nonzero child exits", async () => {
    const result = await runHostProcess(fixtureInput("exit", ["7"]));

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("ordinary failure");
  });

  it("uses a generic error for spawn failures without exposing task data", async () => {
    const taskText = "private task text: rotate credentials";
    const stdin = "private instructions from stdin";

    await expect(
      runHostProcess({
        ...fixtureInput("arguments"),
        command: path.join(fixtureRoot, "missing-host-command"),
        args: [taskText],
        stdin
      })
    ).rejects.toThrow(/^Failed to start host process$/u);

    try {
      await runHostProcess({
        ...fixtureInput("arguments"),
        command: path.join(fixtureRoot, "missing-host-command"),
        args: [taskText],
        stdin
      });
    } catch (error) {
      expect(String(error)).not.toContain(taskText);
      expect(String(error)).not.toContain(stdin);
    }
  });

  it("uses the same generic error when spawn rejects startup input synchronously", async () => {
    const taskText = "private task text in argv";

    await expect(
      runHostProcess({
        ...fixtureInput("arguments"),
        command: "",
        args: [taskText]
      })
    ).rejects.toThrow(/^Failed to start host process$/u);
  });

  it("forwards only the already-sanitized environment supplied by the caller", async () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      HOME: path.join(fixtureRoot, "home"),
      TMPDIR: path.join(fixtureRoot, "tmp"),
      CODEX_HOME: path.join(fixtureRoot, "codex-state"),
      GENKI_SESSION_ID: "session-1",
      GENKI_TASK_ID: "task-1",
      GENKI_ATTEMPT_ID: "attempt-1"
    };

    const result = await runHostProcess({
      ...fixtureInput("environment"),
      environment
    });

    const receivedEnvironment = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
    expect(receivedEnvironment).toMatchObject(environment);
    expect(
      Object.keys(receivedEnvironment).filter(
        (name) => !(name in environment) && name !== "__CF_USER_TEXT_ENCODING"
      )
    ).toEqual([]);
    expect(result.stdout).not.toContain("OPENAI_API_KEY");
  });

  it("writes optional stdin to the child without echoing it elsewhere", async () => {
    const stdin = "instructions stay on the child pipe";

    const result = await runHostProcess({
      ...fixtureInput("stdin"),
      stdin
    });

    expect(result.stdout).toBe(stdin);
    expect(result.stderr).toBe("");
  });
});
