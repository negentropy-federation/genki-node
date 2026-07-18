import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertSafeIdentifier,
  getSessionPaths,
  getTaskRunPaths,
  readJson
} from "./storage.js";
import type { CleanupReport, OwnershipMarker, SessionPaths } from "./types.js";

export class CleanupSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupSafetyError";
  }
}

async function assertOwnedDirectory(
  root: string,
  markerPath: string,
  expected: Pick<OwnershipMarker, "kind" | "sessionId"> & { runId?: string }
): Promise<void> {
  let rootStat;
  let markerStat;
  try {
    rootStat = await lstat(root);
    markerStat = await lstat(markerPath);
  } catch {
    throw new CleanupSafetyError(`Missing Genki ownership data for ${root}`);
  }

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CleanupSafetyError(`Refusing to clean non-directory or symlink: ${root}`);
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new CleanupSafetyError(`Invalid Genki ownership marker: ${markerPath}`);
  }

  let marker: OwnershipMarker;
  try {
    marker = await readJson<OwnershipMarker>(markerPath);
  } catch {
    throw new CleanupSafetyError(`Unreadable Genki ownership marker: ${markerPath}`);
  }

  if (
    marker.format !== "genki-owned-v1" ||
    marker.kind !== expected.kind ||
    marker.sessionId !== expected.sessionId ||
    marker.runId !== expected.runId
  ) {
    throw new CleanupSafetyError(`Ownership marker does not match ${root}`);
  }
}

export async function cleanupTaskRun(
  session: SessionPaths,
  runId: string
): Promise<CleanupReport> {
  try {
    assertSafeIdentifier(runId, "Run ID");
  } catch (error) {
    throw new CleanupSafetyError((error as Error).message);
  }
  const sessionId = path.basename(session.root);
  await assertOwnedDirectory(session.root, session.markerPath, {
    kind: "session",
    sessionId
  });
  const run = getTaskRunPaths(session, runId);
  await assertOwnedDirectory(run.root, run.markerPath, {
    kind: "task-run",
    sessionId,
    runId
  });
  await rm(run.root, { recursive: true, force: false, maxRetries: 2 });
  await rm(run.workspace, { recursive: true, force: false, maxRetries: 2 });
  await rm(run.temporaryHome, { recursive: true, force: false, maxRetries: 2 });
  return { removedPaths: [run.root, run.workspace, run.temporaryHome] };
}

export async function cleanupSession(
  stateRoot: string,
  sessionId: string
): Promise<CleanupReport> {
  try {
    assertSafeIdentifier(sessionId, "Session ID");
  } catch (error) {
    throw new CleanupSafetyError((error as Error).message);
  }
  const session = getSessionPaths(stateRoot, sessionId);
  await assertOwnedDirectory(session.root, session.markerPath, {
    kind: "session",
    sessionId
  });
  await rm(session.root, { recursive: true, force: false, maxRetries: 2 });
  return { removedPaths: [session.root] };
}

export async function cleanupExpiredSessions(
  stateRoot: string,
  now: Date
): Promise<CleanupReport[]> {
  let entries;
  try {
    entries = await readdir(path.resolve(stateRoot), { withFileTypes: true });
  } catch {
    return [];
  }

  const reports: CleanupReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/u.test(entry.name)) {
      continue;
    }
    const session = getSessionPaths(stateRoot, entry.name);
    try {
      const record = await readJson<{ expiresAt?: string }>(session.sessionFile);
      if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime()) {
        reports.push(await cleanupSession(stateRoot, entry.name));
      }
    } catch (error) {
      if (error instanceof CleanupSafetyError) {
        throw error;
      }
    }
  }
  return reports;
}
