import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CleanupSafetyError, cleanupSession, cleanupTaskRun } from "./cleanup.js";
import { createSessionStorage, createTaskRunStorage, writeJsonAtomic } from "./storage.js";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("model-free cleanup", () => {
  it("removes a marked task run without removing the session", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-clean-"));
    const session = await createSessionStorage(stateRoot, "session-1");
    const run = await createTaskRunStorage(session, "run-1");
    await mkdir(path.join(run.root, "workspace"));
    await writeFile(path.join(run.root, "workspace", "task.txt"), "private task");

    const report = await cleanupTaskRun(session, "run-1");

    expect(report.removedPaths).toEqual([run.root]);
    expect(await exists(run.root)).toBe(false);
    expect(await exists(session.root)).toBe(true);
  });

  it("removes every Genki-owned artifact in a marked session", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-clean-"));
    const session = await createSessionStorage(stateRoot, "session-1");
    const run = await createTaskRunStorage(session, "run-1");
    await writeFile(session.agyLogPath, "host log");
    await writeFile(path.join(run.root, "patch.diff"), "private patch");

    const report = await cleanupSession(stateRoot, "session-1");

    expect(report.removedPaths).toEqual([session.root]);
    expect(await exists(session.root)).toBe(false);
  });

  it.each(["../outside", "nested/session", "bad id"])("rejects unsafe session id %s", async (id) => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-clean-"));
    await expect(cleanupSession(stateRoot, id)).rejects.toThrow(CleanupSafetyError);
  });

  it("rejects a symlinked session root and preserves its target", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-clean-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "genki-outside-"));
    await writeFile(path.join(outside, "keep.txt"), "keep");
    await symlink(outside, path.join(stateRoot, "session-1"));

    await expect(cleanupSession(stateRoot, "session-1")).rejects.toThrow(CleanupSafetyError);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects missing and mismatched ownership markers", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-clean-"));
    const missingRoot = path.join(stateRoot, "missing-marker");
    await mkdir(missingRoot);
    await expect(cleanupSession(stateRoot, "missing-marker")).rejects.toThrow(CleanupSafetyError);

    const session = await createSessionStorage(stateRoot, "session-1");
    await writeJsonAtomic(session.markerPath, {
      format: "genki-owned-v1",
      kind: "session",
      sessionId: "different-session",
      createdAt: new Date().toISOString()
    });
    await expect(cleanupSession(stateRoot, "session-1")).rejects.toThrow(CleanupSafetyError);
  });
});
