import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OwnershipMarker, SessionPaths, TaskRunPaths } from "./types.js";

export const OWNERSHIP_MARKER = ".genki-owner.json";

const safeIdentifier = /^[A-Za-z0-9._-]+$/u;

export function assertSafeIdentifier(value: string, label: string): void {
  if (!safeIdentifier.test(value)) {
    throw new TypeError(`${label} contains unsafe characters`);
  }
}

export function getSessionPaths(stateRoot: string, sessionId: string): SessionPaths {
  assertSafeIdentifier(sessionId, "Session ID");
  const resolvedStateRoot = path.resolve(stateRoot);
  const root = path.join(resolvedStateRoot, sessionId);
  if (path.dirname(root) !== resolvedStateRoot) {
    throw new TypeError("Session path escapes the configured state root");
  }
  return {
    stateRoot: resolvedStateRoot,
    root,
    markerPath: path.join(root, OWNERSHIP_MARKER),
    sessionFile: path.join(root, "session.json"),
    runsRoot: path.join(root, "runs"),
    agyLogPath: path.join(root, "agy.log")
  };
}

export function getTaskRunPaths(session: SessionPaths, runId: string): TaskRunPaths {
  assertSafeIdentifier(runId, "Run ID");
  const root = path.join(session.runsRoot, runId);
  if (path.dirname(root) !== session.runsRoot) {
    throw new TypeError("Run path escapes the session runs root");
  }
  return {
    root,
    markerPath: path.join(root, OWNERSHIP_MARKER),
    runFile: path.join(root, "run.json"),
    workspace: path.join(root, "workspace"),
    temporaryHome: path.join(root, "home")
  };
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export async function readJson<T = unknown>(target: string): Promise<T> {
  return JSON.parse(await readFile(target, "utf8")) as T;
}

export async function createSessionStorage(
  stateRoot: string,
  sessionId: string
): Promise<SessionPaths> {
  const paths = getSessionPaths(stateRoot, sessionId);
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.root, { mode: 0o700 });
  await mkdir(paths.runsRoot, { mode: 0o700 });
  const marker: OwnershipMarker = {
    format: "genki-owned-v1",
    kind: "session",
    sessionId,
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(paths.markerPath, marker);
  return paths;
}

export async function createTaskRunStorage(
  session: SessionPaths,
  runId: string
): Promise<TaskRunPaths> {
  const paths = getTaskRunPaths(session, runId);
  await mkdir(paths.root, { mode: 0o700 });
  await mkdir(paths.temporaryHome, { mode: 0o700 });
  const marker: OwnershipMarker = {
    format: "genki-owned-v1",
    kind: "task-run",
    sessionId: path.basename(session.root),
    runId,
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(paths.markerPath, marker);
  return paths;
}
