import { execFile } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildPatch, cloneRepository, inspectRepository } from "./repository.js";
import type { TaskDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "genki-repository-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Genki Test");
  await git(repository, "config", "user.email", "genki@example.invalid");
  await writeFile(path.join(repository, "value.txt"), "before\n");
  await git(repository, "add", "value.txt");
  await git(repository, "commit", "-m", "initial");
  return repository;
}

function taskFor(repository: string): TaskDefinition {
  return {
    schemaVersion: "1",
    id: "repository-test",
    title: "Repository test",
    repository: { path: repository, baseRef: "HEAD" },
    instructions: "Change the fixture.",
    validation: [{ argv: [process.execPath, "--version"], timeoutSeconds: 5 }],
    policy: { maxRuntimeSeconds: 30, maxChangedFiles: 5, maxPatchBytes: 10_000 }
  };
}

describe("inspectRepository", () => {
  it("resolves a clean local repository to a commit", async () => {
    const repository = await createRepository();
    const inspection = await inspectRepository(taskFor(repository));

    expect(inspection.sourcePath).toBe(repository);
    expect(inspection.baseCommit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("rejects dirty repositories", async () => {
    const repository = await createRepository();
    await writeFile(path.join(repository, "value.txt"), "dirty\n");

    await expect(inspectRepository(taskFor(repository))).rejects.toThrow("clean");
  });

  it("rejects configured submodules", async () => {
    const repository = await createRepository();
    await writeFile(
      path.join(repository, ".gitmodules"),
      '[submodule "outside"]\n\tpath = outside\n\turl = ../outside\n'
    );
    await git(repository, "add", ".gitmodules");
    await git(repository, "commit", "-m", "add submodule config");

    await expect(inspectRepository(taskFor(repository))).rejects.toThrow("submodule");
  });

  it("rejects tracked symlinks that escape the repository", async () => {
    const repository = await createRepository();
    await symlink("../outside-secret", path.join(repository, "escape"));
    await git(repository, "add", "escape");
    await git(repository, "commit", "-m", "add escaping symlink");

    await expect(inspectRepository(taskFor(repository))).rejects.toThrow("symlink");
  });
});

describe("cloneRepository and buildPatch", () => {
  it("isolates changes from source contents and refs", async () => {
    const repository = await createRepository();
    const sourceHead = await git(repository, "rev-parse", "HEAD");
    const destinationParent = await mkdtemp(path.join(os.tmpdir(), "genki-clone-"));
    const destination = path.join(destinationParent, "workspace");
    const inspection = await inspectRepository(taskFor(repository));

    await cloneRepository(inspection, destination);
    await writeFile(path.join(destination, "value.txt"), "after\n");
    const patch = await buildPatch(destination);

    expect(patch.changedFiles).toEqual(["value.txt"]);
    expect(patch.patch).toContain("+after");
    expect(patch.patchBytes).toBeGreaterThan(0);
    expect(patch.patchDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(path.join(repository, "value.txt"), "utf8")).toBe("before\n");
    expect(await git(repository, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(await git(destination, "rev-parse", "--git-dir")).toBe(".git");
  });
});
