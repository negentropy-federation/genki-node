import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  PatchSummary,
  RepositoryInspection,
  TaskDefinition
} from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: "C" }
  });
  return stdout;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function rejectEscapingSymlinks(repository: string): Promise<void> {
  const listing = await git(repository, ["ls-files", "-s", "-z"]);
  for (const entry of listing.split("\0")) {
    if (!entry.startsWith("120000 ")) {
      continue;
    }
    const tab = entry.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const relativePath = entry.slice(tab + 1);
    const linkPath = path.join(repository, relativePath);
    const target = await readlink(linkPath);
    const resolvedTarget = path.resolve(path.dirname(linkPath), target);
    if (path.isAbsolute(target) || !isInside(repository, resolvedTarget)) {
      throw new Error(`Tracked symlink escapes repository: ${relativePath}`);
    }
  }
}

export async function inspectRepository(task: TaskDefinition): Promise<RepositoryInspection> {
  const sourcePath = path.resolve(task.repository.path);
  const topLevel = (await git(sourcePath, ["rev-parse", "--show-toplevel"])).trim();
  const [canonicalSource, canonicalTopLevel] = await Promise.all([
    realpath(sourcePath),
    realpath(topLevel)
  ]);
  if (canonicalTopLevel !== canonicalSource) {
    throw new Error("Repository path must point to the Git top-level directory");
  }

  const status = await git(sourcePath, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.length > 0) {
    throw new Error("Source repository must be clean");
  }

  try {
    await access(path.join(sourcePath, ".gitmodules"));
    throw new Error("Repositories with configured submodules are not supported");
  } catch (error) {
    if (error instanceof Error && error.message.includes("submodules")) {
      throw error;
    }
  }

  await rejectEscapingSymlinks(sourcePath);
  const baseCommit = (await git(sourcePath, ["rev-parse", `${task.repository.baseRef}^{commit}`])).trim();
  return { sourcePath, baseCommit };
}

export async function cloneRepository(
  inspection: RepositoryInspection,
  destination: string
): Promise<void> {
  const parent = path.dirname(destination);
  await git(parent, [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "--no-checkout",
    inspection.sourcePath,
    destination
  ]);
  await git(destination, ["checkout", "--detach", inspection.baseCommit]);
}

export async function buildPatch(workspace: string): Promise<PatchSummary> {
  const patch = await git(workspace, ["diff", "--binary", "--no-ext-diff"]);
  const names = await git(workspace, ["diff", "--name-only", "-z", "--no-ext-diff"]);
  const changedFiles = names.split("\0").filter((name) => name.length > 0);
  const patchBytes = Buffer.byteLength(patch, "utf8");
  const patchDigest = createHash("sha256").update(patch, "utf8").digest("hex");
  return { patch, patchBytes, patchDigest, changedFiles };
}
