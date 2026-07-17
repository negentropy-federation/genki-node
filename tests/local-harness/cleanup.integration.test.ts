import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cleanupExpiredSessions } from "../../packages/core/src/cleanup.js";
import {
  createSessionStorage,
  createTaskRunStorage,
  writeJsonAtomic
} from "../../packages/core/src/storage.js";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("expired-session cleanup", () => {
  it("clears marked artifacts without Agy, Codex, or network", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "genki-expired-state-"));
    const session = await createSessionStorage(stateRoot, "expired-session");
    const run = await createTaskRunStorage(session, "expired-run");
    await writeFile(session.agyLogPath, "redirected Agy log");
    await writeFile(path.join(run.root, "private-task.txt"), "private task residue");
    await writeFile(path.join(run.root, "checkpoint.diff"), "diff residue");
    await writeFile(path.join(run.root, "checkpoint.json"), "{}");
    await writeFile(path.join(run.root, "codex.log"), "host log residue");
    await writeFile(path.join(run.temporaryHome, "token"), "session-token-residue");
    await writeJsonAtomic(session.sessionFile, { expiresAt: "2026-07-15T00:00:00.000Z" });
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const reports = await cleanupExpiredSessions(
        stateRoot,
        new Date("2026-07-16T00:00:00.000Z")
      );
      expect(reports).toHaveLength(1);
    } finally {
      process.env.PATH = originalPath;
    }

    expect(await exists(session.root)).toBe(false);
    expect(await exists(run.root)).toBe(false);
  });
});
