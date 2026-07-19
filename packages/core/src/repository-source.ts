import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { LeasedTask, SessionPolicy } from "./types.js";

const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat"
};

async function gitClone(url: string, destination: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", "--no-checkout", url, destination], {
      env: gitEnv,
      stdio: "ignore"
    });
    
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`git clone timed out`));
    }, 60_000);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git clone failed with code ${code}`));
      }
    });
  });
}

function hasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

export async function acquireRepository(
  task: LeasedTask,
  policy: SessionPolicy,
  baseDirectory: string
): Promise<string> {
  const repo = task.project;
  
  if (hasCredentials(repo.repositoryUrl)) {
    throw new Error("Repository URL must not contain credentials");
  }

  if (repo.repositoryClass === "first_party_private") {
    if (!policy.allowedRepositoryClasses.includes(repo.repositoryClass)) {
      throw new Error(`Repository class ${repo.repositoryClass} is not allowed by policy`);
    }
  }

  // Safe unique path for clone
  const hash = createHash("sha256").update(repo.repositoryUrl).digest("hex").slice(0, 16);
  const repoDir = path.join(baseDirectory, hash);

  await rm(repoDir, { recursive: true, force: true });
  await mkdir(path.dirname(repoDir), { recursive: true });

  try {
    await gitClone(repo.repositoryUrl, repoDir);
  } catch (e) {
    await rm(repoDir, { recursive: true, force: true });
    throw new Error(`Failed to acquire repository: ${e instanceof Error ? e.message : String(e)}`);
  }

  return repoDir;
}
