import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgyHostAdapter, buildAgyTaskArgs, type AgyTaskOptions } from "./agy.js";
import type { HostRunInput } from "./types.js";

const fakeAgyPath = fileURLToPath(
  new URL("../../../tests/fake-hosts/fake-agy.mjs", import.meta.url)
);

let testRoot: string;

beforeAll(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "genki-agy-adapter-"));
  await chmod(fakeAgyPath, 0o755);
});

afterAll(async () => {
  await rm(testRoot, { force: true, recursive: true });
});

function taskOptions(model: string | null = null): AgyTaskOptions {
  return {
    workspace: "/tmp/run/workspace",
    logPath: "/tmp/run/agy.log",
    prompt: "Complete the assigned task",
    model
  };
}

async function createRun(
  name: string,
  mode = "success",
  overrides: Partial<HostRunInput> = {}
): Promise<{
  adapter: AgyHostAdapter;
  input: HostRunInput;
  nativeHome: string;
  runRoot: string;
  temporaryHome: string;
  workspace: string;
}> {
  const runRoot = path.join(testRoot, name);
  const temporaryHome = path.join(runRoot, "home");
  const workspace = path.join(runRoot, "workspace");
  const nativeHome = path.join(testRoot, `${name}-native-home`);
  await mkdir(temporaryHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(nativeHome, { recursive: true });
  await writeFile(path.join(workspace, ".fake-agy-mode"), mode);

  const parentEnvironment: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    HOME: nativeHome,
    TMPDIR: path.join(testRoot, "parent-tmp"),
    OPENAI_API_KEY: "must-not-leak",
    ANTHROPIC_API_KEY: "must-not-leak",
    GOOGLE_APPLICATION_CREDENTIALS: "/must/not/leak",
    AWS_SECRET_ACCESS_KEY: "must-not-leak",
    SSH_AUTH_SOCK: "/must/not/leak"
  };
  const adapter = new AgyHostAdapter({ command: fakeAgyPath, parentEnvironment });
  const input: HostRunInput = {
    sessionId: "session-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    workspace,
    instructions: "Private task instructions with a newline\nand quoted text",
    model: null,
    timeoutSeconds: 5,
    temporaryHome,
    abortSignal: new AbortController().signal,
    ...overrides
  };
  return { adapter, input, nativeHome, runRoot, temporaryHome, workspace };
}

async function readCallRecords(temporaryHome: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(temporaryHome, "fake-agy-calls.json"), "utf8");
  return JSON.parse(text) as Array<Record<string, unknown>>;
}

async function waitForCallRecord(temporaryHome: string): Promise<void> {
  const recordPath = path.join(temporaryHome, "fake-agy-calls.json");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(recordPath, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for fake Agy call record");
}

describe("buildAgyTaskArgs", () => {
  it("builds the exact sandboxed one-task argument list", () => {
    expect(buildAgyTaskArgs(taskOptions())).toEqual([
      "--sandbox",
      "--dangerously-skip-permissions",
      "--new-project",
      "--add-dir",
      "/tmp/run/workspace",
      "--log-file",
      "/tmp/run/agy.log",
      "--print",
      "Complete the assigned task"
    ]);
  });

  it("places an optional model immediately before print and prompt", () => {
    expect(buildAgyTaskArgs(taskOptions("Gemini 3.5 Flash (Low)"))).toEqual([
      "--sandbox",
      "--dangerously-skip-permissions",
      "--new-project",
      "--add-dir",
      "/tmp/run/workspace",
      "--log-file",
      "/tmp/run/agy.log",
      "--model",
      "Gemini 3.5 Flash (Low)",
      "--print",
      "Complete the assigned task"
    ]);
  });
});

describe("AgyHostAdapter", () => {
  it("runs one fresh project with a private prompt and strict environment", async () => {
    const run = await createRun("successful-run");

    const result = await run.adapter.runTask(run.input);
    const [record] = await readCallRecords(run.temporaryHome);
    const environment = record?.environment as NodeJS.ProcessEnv;

    expect(result).toEqual({
      host: "agy",
      outcome: "completed",
      exitCode: 0,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
    expect(record?.safeArgv).toEqual([
      "--sandbox",
      "--dangerously-skip-permissions",
      "--new-project",
      "--add-dir",
      run.workspace,
      "--log-file",
      path.join(run.runRoot, "agy.log"),
      "--print",
      "[REDACTED]"
    ]);
    expect(record?.promptSha256).toBe(
      createHash("sha256").update(run.input.instructions).digest("hex")
    );
    expect(record?.promptBytes).toBe(Buffer.byteLength(run.input.instructions));
    expect(JSON.stringify(record)).not.toContain(run.input.instructions);
    expect(await realpath(String(record?.workingDirectory))).toBe(await realpath(run.workspace));
    expect(record?.logPath).toBe(path.join(run.runRoot, "agy.log"));
    expect(environment).toMatchObject({
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      HOME: run.nativeHome,
      TMPDIR: run.temporaryHome,
      GENKI_SESSION_ID: "session-1",
      GENKI_TASK_ID: "task-1",
      GENKI_ATTEMPT_ID: "attempt-1"
    });
    expect(
      Object.keys(environment).filter(
        (name) =>
          ![
            "PATH",
            "LANG",
            "LC_ALL",
            "TERM",
            "HOME",
            "TMPDIR",
            "GENKI_SESSION_ID",
            "GENKI_TASK_ID",
            "GENKI_ATTEMPT_ID",
            "__CF_USER_TEXT_ENCODING"
          ].includes(name)
      )
    ).toEqual([]);
    expect(JSON.stringify(environment)).not.toContain("must-not-leak");
  });

  it("starts a fresh process and project for every task invocation", async () => {
    const run = await createRun("fresh-processes");

    await run.adapter.runTask(run.input);
    await run.adapter.runTask({ ...run.input, attemptId: "attempt-2" });
    const records = await readCallRecords(run.temporaryHome);

    expect(records).toHaveLength(2);
    expect(records[0]?.pid).not.toBe(records[1]?.pid);
    expect(records.every((record) => (record.safeArgv as string[]).includes("--new-project"))).toBe(
      true
    );
  });

  it("rejects a workspace outside the marked task-run root", async () => {
    const run = await createRun("workspace-outside-root");

    await expect(
      run.adapter.runTask({
        ...run.input,
        workspace: path.join(testRoot, "other-root", "workspace")
      })
    ).rejects.toThrow(/^Invalid Agy task paths$/u);
  });

  it("normalizes nonzero and process-start failures without exposing the prompt", async () => {
    const nonzero = await createRun("nonzero-run", "nonzero");
    await expect(nonzero.adapter.runTask(nonzero.input)).resolves.toEqual({
      host: "agy",
      outcome: "host_failed",
      exitCode: 9,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });

    const missing = await createRun("missing-command");
    const adapter = new AgyHostAdapter({
      command: path.join(testRoot, "missing-agy"),
      parentEnvironment: { PATH: "/usr/bin:/bin", HOME: missing.nativeHome }
    });
    const result = await adapter.runTask(missing.input);

    expect(result).toEqual({
      host: "agy",
      outcome: "host_failed",
      exitCode: null,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
    expect(JSON.stringify(result)).not.toContain(missing.input.instructions);
  });

  it("terminates the child and reports interrupted when aborted", async () => {
    const controller = new AbortController();
    const run = await createRun("aborted-run", "hang", {
      abortSignal: controller.signal
    });

    const resultPromise = run.adapter.runTask(run.input);
    await waitForCallRecord(run.temporaryHome);
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      host: "agy",
      outcome: "interrupted",
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
  });

  it("reports timed_out when the child exceeds its task timeout", async () => {
    const run = await createRun("timed-out-run", "hang", { timeoutSeconds: 0.03 });

    await expect(run.adapter.runTask(run.input)).resolves.toMatchObject({
      host: "agy",
      outcome: "timed_out",
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
  });

  it("probes Agy with a bounded version command and enforces 1.1.2", async () => {
    const run = await createRun("availability");

    await expect(run.adapter.checkAvailability()).resolves.toEqual({
      available: true,
      version: "1.1.2",
      reason: "available"
    });

    await writeFile(path.join(run.nativeHome, "fake-agy-version.txt"), "agy 1.1.1");
    await expect(run.adapter.checkAvailability()).resolves.toEqual({
      available: false,
      version: "1.1.1",
      reason: "unsupported_version"
    });
  });

  it("fails a hung version probe at the injected absolute timeout", async () => {
    const run = await createRun("availability-hang");
    await writeFile(path.join(run.nativeHome, "fake-agy-version.txt"), "hang");
    const adapter = new AgyHostAdapter({
      command: fakeAgyPath,
      parentEnvironment: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: run.nativeHome
      },
      availabilityTimeoutMs: 25
    });
    const startedAt = Date.now();

    await expect(adapter.checkAvailability()).resolves.toEqual({
      available: false,
      version: null,
      reason: "probe_failed"
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});
