import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createSessionStorage,
  createTaskRunStorage,
  readJson,
  writeJsonAtomic
} from "./storage.js";

describe("marked storage", () => {
  it("creates matching session and task-run ownership markers", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-storage-"));
    const session = await createSessionStorage(stateRoot, "session-1");
    const run = await createTaskRunStorage(session, "run-1");

    await expect(readJson(session.markerPath)).resolves.toMatchObject({
      format: "genki-owned-v1",
      kind: "session",
      sessionId: "session-1"
    });
    await expect(readJson(run.markerPath)).resolves.toMatchObject({
      format: "genki-owned-v1",
      kind: "task-run",
      sessionId: "session-1",
      runId: "run-1"
    });
  });

  it("writes JSON atomically without leaving a temporary file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "genki-json-"));
    const target = path.join(directory, "state.json");

    await writeJsonAtomic(target, { state: "active" });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ state: "active" });
    await expect(readFile(`${target}.tmp`, "utf8")).rejects.toThrow();
  });

  it("replaces an existing JSON file atomically", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "genki-json-"));
    const target = path.join(directory, "state.json");
    await writeFile(target, '{"state":"configured"}\n');

    await writeJsonAtomic(target, { state: "active" });

    await expect(readJson(target)).resolves.toEqual({ state: "active" });
  });
});
