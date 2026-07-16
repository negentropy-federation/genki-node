import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CodexHostAdapter,
  buildCodexArgs,
  parseCodexJsonl,
  type CodexTaskOptions
} from "./codex.js";
import type { HostRunInput } from "./types.js";

const fakeCodexPath = fileURLToPath(
  new URL("../../../tests/fake-hosts/fake-codex.mjs", import.meta.url)
);

const finalSchema = {
  type: "object",
  properties: {
    completedCriteria: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 32
    },
    remainingCriteria: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 32
    }
  },
  required: ["completedCriteria", "remainingCriteria"],
  additionalProperties: false
};

let testRoot: string;

beforeAll(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "genki-codex-adapter-"));
  await chmod(fakeCodexPath, 0o755);
});

afterAll(async () => {
  await rm(testRoot, { force: true, recursive: true });
});

function taskOptions(model: string | null = null): CodexTaskOptions {
  return {
    workspace: "/tmp/workspace",
    schemaPath: "/tmp/schema.json",
    model
  };
}

async function createRun(
  name: string,
  mode = "success",
  overrides: Partial<HostRunInput> = {}
): Promise<{
  adapter: CodexHostAdapter;
  home: string;
  input: HostRunInput;
  workspace: string;
}> {
  const root = path.join(testRoot, name);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const nativeHome = path.join(root, "native-home");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(nativeHome, { recursive: true });
  await writeFile(path.join(workspace, ".fake-codex-mode"), mode);

  const parentEnvironment: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    HOME: nativeHome,
    TMPDIR: path.join(root, "parent-tmp"),
    OPENAI_API_KEY: "must-not-leak",
    AWS_SECRET_ACCESS_KEY: "must-not-leak",
    SSH_AUTH_SOCK: "/must/not/leak"
  };
  const adapter = new CodexHostAdapter({
    command: fakeCodexPath,
    parentEnvironment
  });
  const input: HostRunInput = {
    sessionId: "session-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    workspace,
    instructions: "Synthetic instructions sent only over stdin",
    model: null,
    timeoutSeconds: 5,
    temporaryHome: home,
    abortSignal: new AbortController().signal,
    ...overrides
  };
  return { adapter, home, input, workspace };
}

async function readCallRecords(home: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(home, "fake-codex-calls.json"), "utf8");
  return JSON.parse(text) as Array<Record<string, unknown>>;
}

describe("buildCodexArgs", () => {
  it("builds the exact bounded ephemeral argument list", () => {
    expect(buildCodexArgs(taskOptions())).toEqual([
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--output-schema",
      "/tmp/schema.json",
      "-C",
      "/tmp/workspace",
      "-"
    ]);
  });

  it("inserts a selected model immediately before stdin", () => {
    expect(buildCodexArgs(taskOptions("gpt-5-codex"))).toEqual([
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--output-schema",
      "/tmp/schema.json",
      "-C",
      "/tmp/workspace",
      "--model",
      "gpt-5-codex",
      "-"
    ]);
  });
});

describe("parseCodexJsonl", () => {
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-local-only" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "future.event", value: "ignored" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          completedCriteria: ["first criterion"],
          remainingCriteria: ["second criterion"]
        })
      }
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 10
      }
    })
  ].join("\n");

  it("normalizes only usage and final acceptance criteria", () => {
    const parsed = parseCodexJsonl(`\n${jsonl}\n\n`);

    expect(parsed).toEqual({
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 10
      },
      completedCriteria: ["first criterion"],
      remainingCriteria: ["second criterion"]
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "completedCriteria",
      "remainingCriteria",
      "usage"
    ]);
    expect(JSON.stringify(parsed)).not.toContain("thread-local-only");
    expect(JSON.stringify(parsed)).not.toContain("future.event");
  });

  it("fails closed on any malformed nonblank line", () => {
    expect(() => parseCodexJsonl(`${jsonl}\n{malformed}`)).toThrow(
      /^Invalid Codex host output$/u
    );
  });

  it("rejects invalid usage and criteria bounds", () => {
    const invalidUsage = jsonl.replace('"input_tokens":100', '"input_tokens":-1');
    const tooManyCriteria = jsonl.replace(
      '\\"completedCriteria\\":[\\"first criterion\\"]',
      `\\"completedCriteria\\":[${Array.from({ length: 33 }, () => '\\"criterion\\"').join(",")}]`
    );

    expect(() => parseCodexJsonl(invalidUsage)).toThrow(/^Invalid Codex host output$/u);
    expect(() => parseCodexJsonl(tooManyCriteria)).toThrow(/^Invalid Codex host output$/u);
  });
});

describe("CodexHostAdapter", () => {
  it("writes the exact private schema and sends instructions only through stdin", async () => {
    const { adapter, home, input } = await createRun("successful-run");

    const result = await adapter.runTask(input);
    const [record] = await readCallRecords(home);
    const argv = record?.argv as string[];
    const environment = record?.environment as NodeJS.ProcessEnv;
    const schemaPath = argv[argv.indexOf("--output-schema") + 1];
    if (schemaPath === undefined) {
      throw new Error("Fake Codex call did not include an output schema");
    }

    expect(result).toEqual({
      host: "codex",
      outcome: "completed",
      exitCode: 0,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 10
      },
      completedCriteria: ["criterion complete"],
      remainingCriteria: ["criterion remaining"]
    });
    expect(argv).toEqual(buildCodexArgs({ workspace: input.workspace, schemaPath, model: null }));
    expect(argv).not.toContain(input.instructions);
    expect(JSON.stringify(record)).not.toContain(input.instructions);
    expect(record?.stdinSha256).toBe(
      createHash("sha256").update(input.instructions).digest("hex")
    );
    expect(record?.stdinBytes).toBe(Buffer.byteLength(input.instructions));
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(finalSchema);
    expect((await stat(schemaPath)).mode & 0o777).toBe(0o600);
    expect(environment).toMatchObject({
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      HOME: home,
      TMPDIR: home,
      CODEX_HOME: path.join(path.dirname(home), "native-home", ".codex"),
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
            "CODEX_HOME",
            "GENKI_SESSION_ID",
            "GENKI_TASK_ID",
            "GENKI_ATTEMPT_ID",
            "__CF_USER_TEXT_ENCODING"
          ].includes(name)
      )
    ).toEqual([]);
    expect(JSON.stringify(environment)).not.toContain("must-not-leak");
  });

  it("respects an explicit native CODEX_HOME", async () => {
    const run = await createRun("explicit-codex-home");
    const explicitCodexHome = path.join(testRoot, "explicit-native-codex");
    const adapter = new CodexHostAdapter({
      command: fakeCodexPath,
      parentEnvironment: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(testRoot, "unused-native-home"),
        CODEX_HOME: explicitCodexHome
      }
    });

    await adapter.runTask(run.input);
    const [record] = await readCallRecords(run.home);
    expect((record?.environment as NodeJS.ProcessEnv).CODEX_HOME).toBe(explicitCodexHome);
  });

  it("does not classify structured final criteria as host failure evidence", async () => {
    const { adapter, input } = await createRun(
      "successful-diagnostic-words",
      "success-with-diagnostic-words"
    );

    const result = await adapter.runTask(input);

    expect(result.outcome).toBe("completed");
    expect(result.completedCriteria).toEqual(["Documented codex login behavior"]);
  });

  it("maps explicit host failures without returning captured output", async () => {
    const scenarios = [
      ["quota", "quota_exhausted"],
      ["quota-malformed", "quota_exhausted"],
      ["bare-quota", "host_failed"],
      ["authentication", "authentication_failed"],
      ["capacity-repeated", "capacity_unavailable"],
      ["capacity-once", "host_failed"],
      ["host-failed", "host_failed"],
      ["malformed", "host_failed"],
      ["missing-final", "host_failed"],
      ["missing-turn", "host_failed"],
      ["invalid-usage", "host_failed"],
      ["invalid-criteria", "host_failed"]
    ] as const;

    for (const [mode, outcome] of scenarios) {
      const { adapter, input } = await createRun(`failure-${mode}`, mode);
      const result = await adapter.runTask(input);

      expect(result).toEqual({
        host: "codex",
        outcome,
        exitCode: mode.startsWith("capacity") || ["quota", "quota-malformed", "bare-quota", "authentication", "malformed"].includes(mode)
          ? 1
          : mode === "host-failed"
            ? 9
            : 0,
        usage: null,
        completedCriteria: [],
        remainingCriteria: []
      });
      expect(JSON.stringify(result)).not.toContain("thread-local-only");
      expect(JSON.stringify(result)).not.toContain("temporarily unavailable");
    }
  });

  it("gives abort precedence over timeout and host evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, input } = await createRun("aborted-run", "quota", {
      abortSignal: controller.signal,
      timeoutSeconds: 0
    });

    const result = await adapter.runTask(input);

    expect(result.outcome).toBe("interrupted");
    expect(result.usage).toBeNull();
  });

  it("maps a process timeout to timed_out", async () => {
    const { adapter, input } = await createRun("timed-out-run", "hang", {
      timeoutSeconds: 0.05
    });

    const result = await adapter.runTask(input);

    expect(result.outcome).toBe("timed_out");
    expect(result.usage).toBeNull();
  });

  it("starts a fresh process for every task invocation", async () => {
    const { adapter, home, input } = await createRun("fresh-processes");

    await adapter.runTask(input);
    await adapter.runTask({ ...input, attemptId: "attempt-2" });
    const records = await readCallRecords(home);

    expect(records).toHaveLength(2);
    expect(records[0]?.pid).not.toBe(records[1]?.pid);
  });

  it("probes the local CLI and enforces the minimum version", async () => {
    const run = await createRun("availability");

    await expect(run.adapter.checkAvailability()).resolves.toEqual({
      available: true,
      version: "0.144.2",
      reason: "available"
    });

    await writeFile(path.join(path.dirname(run.home), "native-home", "fake-codex-version.txt"), "codex-cli 0.144.1");
    await expect(run.adapter.checkAvailability()).resolves.toEqual({
      available: false,
      version: "0.144.1",
      reason: "unsupported_version"
    });
  });
});
