import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
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
const schemaFilename = "codex-final-response.schema.json";

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

async function readOwnedTaskFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [nestedPath, text] of await readOwnedTaskFiles(entryPath)) {
        files.set(nestedPath, text);
      }
    } else if (entry.isFile()) {
      files.set(entryPath, await readFile(entryPath, "utf8"));
    }
  }
  return files;
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

  it("uses a later valid agent message after an earlier nonconforming message", () => {
    const lines = jsonl.split("\n");
    lines.splice(
      3,
      0,
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "not-json" }
      })
    );

    expect(parseCodexJsonl(lines.join("\n")).completedCriteria).toEqual([
      "first criterion"
    ]);
  });

  it("fails closed when the last agent message is nonconforming", () => {
    const lines = jsonl.split("\n");
    lines.splice(
      -1,
      0,
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "not-json" }
      })
    );

    expect(() => parseCodexJsonl(lines.join("\n"))).toThrow(
      /^Invalid Codex host output$/u
    );
  });
});

describe("CodexHostAdapter", () => {
  it("writes the exact private schema and keeps complex instructions out of argv and task files", async () => {
    const rawInstructionFragments = [
      "INSTRUCTION_QUOTED_SENTINEL",
      "INSTRUCTION_ESCAPED_SENTINEL",
      "INSTRUCTION_MULTILINE_SENTINEL"
    ];
    const instructions = [
      'Preserve "INSTRUCTION_QUOTED_SENTINEL" exactly.',
      String.raw`Keep \\INSTRUCTION_ESCAPED_SENTINEL\\ escaped.`,
      "First multiline instruction.",
      "INSTRUCTION_MULTILINE_SENTINEL on the next line."
    ].join("\n");
    const { adapter, home, input } = await createRun("successful-run", "success", {
      instructions
    });

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
    for (const argument of argv) {
      for (const fragment of rawInstructionFragments) {
        expect(argument).not.toBe(fragment);
        expect(argument).not.toContain(fragment);
      }
    }
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

    const forbiddenFileSentinels = [
      ...rawInstructionFragments,
      JSON.stringify(input.instructions).slice(1, -1),
      "thread-local-only",
      '\\"thread-local-only\\"',
      "criterion complete",
      '\\"criterion complete\\"',
      "criterion remaining"
    ];
    const ownedFiles = await readOwnedTaskFiles(home);
    expect([...ownedFiles.keys()].sort()).toEqual(
      [path.join(home, schemaFilename), path.join(home, "fake-codex-calls.json")].sort()
    );
    for (const text of ownedFiles.values()) {
      for (const sentinel of forbiddenFileSentinels) {
        expect(text).not.toContain(sentinel);
      }
    }
  });

  it("replaces a destination schema symlink without touching its target", async () => {
    const { adapter, home, input } = await createRun("schema-destination-symlink");
    const outsideTarget = path.join(testRoot, "schema-outside-target.txt");
    const schemaPath = path.join(home, schemaFilename);
    await writeFile(outsideTarget, "outside sentinel", { mode: 0o640 });
    await symlink(outsideTarget, schemaPath);

    const result = await adapter.runTask(input);

    expect(result.outcome).toBe("completed");
    expect(await readFile(outsideTarget, "utf8")).toBe("outside sentinel");
    expect((await lstat(schemaPath)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(finalSchema);
    expect((await stat(schemaPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects symlinked temporary homes and parents with a generic error", async () => {
    const homeRun = await createRun("symlinked-home");
    const redirectedHome = path.join(testRoot, "redirected-home");
    await rm(homeRun.home, { recursive: true });
    await mkdir(redirectedHome);
    await symlink(redirectedHome, homeRun.home);

    await expect(homeRun.adapter.runTask(homeRun.input)).rejects.toThrow(
      /^Failed to prepare Codex task$/u
    );

    const parentRun = await createRun("symlinked-parent");
    const actualParent = path.join(testRoot, "actual-temporary-parent");
    const linkedParent = path.join(testRoot, "linked-temporary-parent");
    await mkdir(path.join(actualParent, "home"), { recursive: true });
    await symlink(actualParent, linkedParent);

    await expect(
      parentRun.adapter.runTask({
        ...parentRun.input,
        temporaryHome: path.join(linkedParent, "home")
      })
    ).rejects.toThrow(/^Failed to prepare Codex task$/u);
  });

  it("rejects a symlinked temporary home with a trailing separator without touching its target", async () => {
    const run = await createRun("symlinked-home-trailing-separator");
    const redirectedHome = path.join(testRoot, "redirected-home-trailing-separator");
    const sentinelPath = path.join(redirectedHome, "outside-sentinel.txt");
    await rm(run.home, { recursive: true });
    await mkdir(redirectedHome);
    await writeFile(sentinelPath, "outside sentinel");
    await symlink(redirectedHome, run.home);

    await expect(
      run.adapter.runTask({
        ...run.input,
        temporaryHome: `${run.home}${path.sep}`
      })
    ).rejects.toThrow(/^Failed to prepare Codex task$/u);

    expect(await readFile(sentinelPath, "utf8")).toBe("outside sentinel");
    expect(await readdir(redirectedHome)).toEqual(["outside-sentinel.txt"]);
  });

  it("rejects non-directory temporary homes and parents with a generic error", async () => {
    const homeRun = await createRun("file-home");
    await rm(homeRun.home, { recursive: true });
    await writeFile(homeRun.home, "not a directory");

    await expect(homeRun.adapter.runTask(homeRun.input)).rejects.toThrow(
      /^Failed to prepare Codex task$/u
    );

    const parentRun = await createRun("file-parent");
    const fileParent = path.join(testRoot, "temporary-parent-file");
    await writeFile(fileParent, "not a directory");

    await expect(
      parentRun.adapter.runTask({
        ...parentRun.input,
        temporaryHome: path.join(fileParent, "home")
      })
    ).rejects.toThrow(/^Failed to prepare Codex task$/u);
  });

  it("removes the private schema temporary file when preparation fails", async () => {
    const { adapter, home, input } = await createRun("schema-cleanup");
    await mkdir(path.join(home, schemaFilename));

    await expect(adapter.runTask(input)).rejects.toThrow(/^Failed to prepare Codex task$/u);

    expect(
      (await readdir(home)).filter((name) =>
        name.startsWith(`.${schemaFilename}.temporary-`)
      )
    ).toEqual([]);
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

  it.each([
    ["usage limit metadata retries exhausted", "usage-limit-metadata-retries-exhausted"],
    ["invalid key in configuration", "invalid-key-configuration"],
    ["two capacity planning status records", "capacity-planning-status"]
  ])("does not classify %s as a known host outcome", async (_description, mode) => {
    const { adapter, input } = await createRun(`diagnostic-negative-${mode}`, mode);

    const result = await adapter.runTask(input);

    expect(result).toEqual({
      host: "codex",
      outcome: "host_failed",
      exitCode: 1,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
  });

  it("maps a structured authentication_error code without returning diagnostics", async () => {
    const { adapter, input } = await createRun(
      "structured-authentication-error",
      "authentication-error-code"
    );

    const result = await adapter.runTask(input);

    expect(result).toEqual({
      host: "codex",
      outcome: "authentication_failed",
      exitCode: 1,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
    expect(JSON.stringify(result)).not.toContain("authentication_error");
  });

  it("ignores unrecognized fields in structured diagnostic events", async () => {
    const { adapter, input } = await createRun(
      "diagnostic-unrecognized-fields",
      "quota-code-in-unrecognized-metadata"
    );

    const result = await adapter.runTask(input);

    expect(result.outcome).toBe("host_failed");
    expect(JSON.stringify(result)).not.toContain("quota_exhausted");
  });

  it(
    "maps explicit host failures without returning captured output",
    async () => {
    const scenarios = [
      ["quota", "quota_exhausted"],
      ["quota-malformed", "quota_exhausted"],
      ["bare-quota", "host_failed"],
      ["usage-metadata-failed", "host_failed"],
      ["credits-exhausted", "quota_exhausted"],
      ["quota-code-exhausted", "quota_exhausted"],
      ["usage-limit-exceeded-code", "quota_exhausted"],
      ["insufficient-quota-code", "quota_exhausted"],
      ["quota-exceeded-code", "quota_exhausted"],
      ["hit-usage-limit", "quota_exhausted"],
      ["authentication", "authentication_failed"],
      ["authentication-incidental-login", "host_failed"],
      ["capacity-repeated", "capacity_unavailable"],
      ["capacity-distinct-events", "capacity_unavailable"],
      ["capacity-phrases-one-record", "host_failed"],
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

      expect(result, mode).toEqual({
        host: "codex",
        outcome,
        exitCode: mode.startsWith("capacity") || ["quota", "quota-malformed", "bare-quota", "usage-metadata-failed", "credits-exhausted", "quota-code-exhausted", "usage-limit-exceeded-code", "insufficient-quota-code", "quota-exceeded-code", "hit-usage-limit", "authentication", "authentication-incidental-login", "malformed"].includes(mode)
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
    },
    30_000
  );

  it("normalizes generic process-start failures as host_failed", async () => {
    const run = await createRun("process-start-failure");
    const adapter = new CodexHostAdapter({
      command: path.join(testRoot, "missing-codex-command"),
      parentEnvironment: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(testRoot, "process-start-native-home")
      }
    });

    await expect(adapter.runTask(run.input)).resolves.toEqual({
      host: "codex",
      outcome: "host_failed",
      exitCode: null,
      usage: null,
      completedCriteria: [],
      remainingCriteria: []
    });
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

  it("finishes a hung availability probe at its injected absolute timeout", async () => {
    const run = await createRun("availability-hang");
    const nativeHome = path.join(path.dirname(run.home), "native-home");
    await writeFile(path.join(nativeHome, "fake-codex-version.txt"), "hang-ignore-term");
    const options = {
      command: fakeCodexPath,
      parentEnvironment: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: nativeHome
      },
      availabilityTimeoutMs: 25
    };
    const adapter = new CodexHostAdapter(options);
    const startedAt = Date.now();

    await expect(adapter.checkAvailability()).resolves.toEqual({
      available: false,
      version: null,
      reason: "probe_failed"
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});
