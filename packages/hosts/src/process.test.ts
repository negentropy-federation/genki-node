import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    process.on("SIGTERM", () => process.stdout.write("SIGTERM\n"));
    writeFileSync(args[0], "ready");
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

  it("sends SIGTERM on timeout and SIGKILL after the default two-second grace period", async () => {
    const readyPath = path.join(fixtureRoot, "timeout-ready");

    const result = await runHostProcess({
      ...fixtureInput("ignore-term", [readyPath]),
      timeoutMs: 300
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toContain("SIGTERM");
    expect(result.durationMs).toBeGreaterThanOrEqual(2_200);
  }, 5_000);

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
