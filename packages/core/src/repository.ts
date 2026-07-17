import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  PartialCheckpoint,
  PatchSummary,
  RepositoryInspection,
  TaskDefinition
} from "./types.js";

const execFileAsync = promisify(execFile);

const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat"
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: gitEnv
  });
  return stdout;
}

async function gitWithStdin(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: gitEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} timed out`));
    }, 15_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code}`));
    });
    child.stdin.end(input, "utf8");
  });
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
  await git(workspace, ["add", "--intent-to-add", "--", "."]);
  const patch = await git(workspace, ["diff", "--binary", "--no-ext-diff"]);
  const names = await git(workspace, ["diff", "--name-only", "-z", "--no-ext-diff"]);
  const changedFiles = names.split("\0").filter((name) => name.length > 0);
  const patchBytes = Buffer.byteLength(patch, "utf8");
  const patchDigest = createHash("sha256").update(patch, "utf8").digest("hex");
  return { patch, patchBytes, patchDigest, changedFiles };
}

function assertSafeCheckpointPatch(patch: string, changedFiles: string[]): void {
  if (/^GIT binary patch$/mu.test(patch) || /^Binary files .* differ$/mu.test(patch)) {
    throw new Error("Binary patches are not supported for checkpoint application");
  }
  for (const file of changedFiles) {
    assertSafeRelativePath(file);
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      if (match === null) {
        throw new Error("Checkpoint patch contains an unsupported path header");
      }
      assertSafeRelativePath(match[1]!);
      assertSafeRelativePath(match[2]!);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        continue;
      }
      assertSafeRelativePath(target.replace(/^[ab]\//u, ""));
    } else if (line.startsWith("rename from ")) {
      assertSafeRelativePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      assertSafeRelativePath(line.slice("rename to ".length));
    }
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.split(/[\\/]/u).some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Checkpoint patch path is unsafe: ${relativePath}`);
  }
}

export async function applyCheckpoint(
  workspace: string,
  checkpoint: PartialCheckpoint
): Promise<void> {
  const resolvedWorkspace = path.resolve(workspace);
  const head = (await git(resolvedWorkspace, ["rev-parse", "HEAD"])).trim();
  if (head !== checkpoint.baseCommit) {
    throw new Error(
      `Workspace base commit ${head} does not match checkpoint base commit ${checkpoint.baseCommit}`
    );
  }
  assertSafeCheckpointPatch(checkpoint.patch, checkpoint.changedFiles);
  await gitWithStdin(
    resolvedWorkspace,
    ["apply", "--check", "--whitespace=error-all"],
    checkpoint.patch
  );
  await gitWithStdin(resolvedWorkspace, ["apply", "--whitespace=error-all"], checkpoint.patch);
}
