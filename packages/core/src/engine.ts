import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { cleanupSession, cleanupTaskRun } from "./cleanup.js";
import { sha256Digest } from "./digest.js";
import { buildChildEnvironment } from "./environment.js";
import { buildPatch, cloneRepository, inspectRepository } from "./repository.js";
import { persistRetainedResult } from "./result.js";
import { parseSessionPolicy, parseTaskDefinition } from "./schema.js";
import { transitionSession, transitionTask } from "./state-machine.js";
import {
  createSessionStorage,
  createTaskRunStorage,
  getSessionPaths,
  getTaskRunPaths,
  readJson,
  writeJsonAtomic
} from "./storage.js";
import type {
  GenericSessionStatus,
  GenericTaskOutcome,
  PreparedTaskForHost,
  SessionDescription,
  SessionPaths,
  SessionPolicy,
  SessionState,
  TaskDefinition,
  TaskRunPaths,
  TaskState,
  ValidationSummary
} from "./types.js";
import { runValidationCommands } from "./validation.js";

interface EngineOptions {
  stateRoot: string;
  now?: () => Date;
  createId?: () => string;
}

interface DescribeSessionInput {
  taskDirectory: string;
  policy: SessionPolicy;
}

interface SessionRecord {
  sessionId: string;
  state: SessionState;
  policy: SessionPolicy;
  policyDigest: string;
  taskDirectory: string;
  taskFiles: string[];
  nextTaskIndex: number;
  completed: number;
  failed: number;
  consumedRuntimeSeconds: number;
  lastOutcomeCode: string | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string | null;
}

interface RunRecord {
  runId: string;
  sessionId: string;
  state: TaskState;
  taskDigest: string;
  baseCommit: string;
  validation: ValidationSummary | null;
}

interface LocatedRun {
  session: SessionPaths;
  run: TaskRunPaths;
  record: RunRecord;
}

export class GenkiEngine {
  readonly #stateRoot: string;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: EngineOptions) {
    this.#stateRoot = path.resolve(options.stateRoot);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async describeSession(input: DescribeSessionInput): Promise<SessionDescription> {
    const policy = parseSessionPolicy(input.policy);
    const taskDirectory = path.resolve(input.taskDirectory);
    const taskDirectoryStat = await lstat(taskDirectory);
    if (!taskDirectoryStat.isDirectory() || taskDirectoryStat.isSymbolicLink()) {
      throw new Error("Task queue must be a local directory, not a symlink");
    }
    const taskFiles = (await readdir(taskDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
    const sessionId = this.#createId();
    const paths = await createSessionStorage(this.#stateRoot, sessionId);
    const policyDigest = sha256Digest({ policy, taskDirectory });
    const createdAt = this.#now().toISOString();
    const record: SessionRecord = {
      sessionId,
      state: transitionSession("configured", "awaiting_session_consent"),
      policy,
      policyDigest,
      taskDirectory,
      taskFiles,
      nextTaskIndex: 0,
      completed: 0,
      failed: 0,
      consumedRuntimeSeconds: 0,
      lastOutcomeCode: null,
      createdAt,
      activatedAt: null,
      expiresAt: null
    };
    await writeJsonAtomic(paths.sessionFile, record);
    return {
      sessionId,
      policyDigest,
      sessionRoot: paths.root,
      agyLogPath: paths.agyLogPath,
      summary: {
        durationSeconds: policy.durationSeconds,
        maxTasks: policy.maxTasks,
        maxTotalRuntimeSeconds: policy.maxTotalRuntimeSeconds,
        maxTaskRuntimeSeconds: policy.maxTaskRuntimeSeconds,
        allowedExecutables: [...policy.allowedExecutables],
        host: policy.host,
        model: policy.model,
        retainUntilVerified: policy.retainUntilVerified
      }
    };
  }

  async activateSession(sessionId: string, policyDigest: string): Promise<GenericSessionStatus> {
    const { paths, record } = await this.#loadSession(sessionId);
    if (record.policyDigest !== policyDigest) {
      throw new Error("Session policy digest does not match the consented policy");
    }
    record.state = transitionSession(record.state, "active");
    const activatedAt = this.#now();
    record.activatedAt = activatedAt.toISOString();
    record.expiresAt = new Date(
      activatedAt.getTime() + record.policy.durationSeconds * 1000
    ).toISOString();
    await writeJsonAtomic(paths.sessionFile, record);
    return this.#status(record);
  }

  async prepareNextTask(sessionId: string): Promise<PreparedTaskForHost | null> {
    const loaded = await this.#loadSession(sessionId);
    const { paths, record } = loaded;
    if (await this.#expireIfNeeded(paths, record)) {
      return null;
    }
    if (record.state !== "active") {
      return null;
    }

    while (
      record.nextTaskIndex < record.taskFiles.length &&
      record.completed + record.failed < record.policy.maxTasks
    ) {
      const filename = record.taskFiles[record.nextTaskIndex];
      record.nextTaskIndex += 1;
      try {
        if (filename === undefined) {
          throw new Error("Task queue index is invalid");
        }
        const taskPath = path.join(record.taskDirectory, filename);
        if (path.dirname(taskPath) !== record.taskDirectory) {
          throw new Error("Task path escapes queue");
        }
        const task = parseTaskDefinition(JSON.parse(await readFile(taskPath, "utf8")) as unknown);
        this.#assertTaskPolicy(record, task);
        const inspection = await inspectRepository(task);
        const runId = this.#createId();
        const runPaths = await createTaskRunStorage(paths, runId);
        await writeJsonAtomic(path.join(runPaths.root, "task.json"), task);
        await cloneRepository(inspection, runPaths.workspace);
        const runRecord: RunRecord = {
          runId,
          sessionId,
          state: transitionTask("policy_checked", "prepared"),
          taskDigest: sha256Digest({ task, baseCommit: inspection.baseCommit }),
          baseCommit: inspection.baseCommit,
          validation: null
        };
        runRecord.state = transitionTask(runRecord.state, "executing");
        await writeJsonAtomic(runPaths.runFile, runRecord);
        await writeJsonAtomic(paths.sessionFile, record);
        return { runId, workspace: runPaths.workspace, instructions: task.instructions };
      } catch {
        record.failed += 1;
        record.lastOutcomeCode = "TASK_REJECTED";
        await writeJsonAtomic(paths.sessionFile, record);
      }
    }
    return null;
  }

  async runValidation(runId: string): Promise<ValidationSummary> {
    const located = await this.#findRun(runId);
    const task = parseTaskDefinition(await readJson(path.join(located.run.root, "task.json")));
    located.record.state = transitionTask(located.record.state, "validating");
    await writeJsonAtomic(located.run.runFile, located.record);
    const validation = await runValidationCommands({
      commands: task.validation,
      cwd: located.run.workspace,
      environment: buildChildEnvironment({
        temporaryHome: located.run.temporaryHome,
        temporaryDirectory: located.run.root,
        metadata: {
          GENKI_SESSION_ID: located.record.sessionId,
          GENKI_RUN_ID: located.record.runId
        }
      }),
      maxTotalRuntimeSeconds: task.policy.maxRuntimeSeconds
    });
    located.record.validation = validation;
    located.record.state = transitionTask(located.record.state, "finalizing");
    await writeJsonAtomic(located.run.runFile, located.record);
    return validation;
  }

  async finalizeAndDeliver(runId: string): Promise<GenericTaskOutcome> {
    const located = await this.#findRun(runId);
    if (located.record.state !== "finalizing" || located.record.validation === null) {
      throw new Error("Run is not ready for finalization");
    }
    const task = parseTaskDefinition(await readJson(path.join(located.run.root, "task.json")));
    const patch = await buildPatch(located.run.workspace);
    const { record: sessionRecord } = await this.#loadSession(located.record.sessionId);
    const exceedsPolicy =
      patch.changedFiles.length > task.policy.maxChangedFiles ||
      patch.changedFiles.length > sessionRecord.policy.maxChangedFiles ||
      patch.patchBytes > task.policy.maxPatchBytes ||
      patch.patchBytes > sessionRecord.policy.maxPatchBytes;

    let outcome: GenericTaskOutcome;
    if (exceedsPolicy) {
      located.record.state = transitionTask(located.record.state, "frozen");
      outcome = { code: "POLICY_FROZEN", passed: false };
    } else if (!located.record.validation.passed) {
      located.record.state = transitionTask(located.record.state, "failed");
      outcome = { code: "VALIDATION_FAILED", passed: false };
    } else {
      located.record.state = transitionTask(located.record.state, "delivered");
      outcome = { code: "DELIVERED", passed: true };
    }
    await writeJsonAtomic(located.run.runFile, located.record);

    if (sessionRecord.policy.retainUntilVerified) {
      await persistRetainedResult({
        runRoot: located.run.root,
        outcome,
        patch,
        validation: located.record.validation
      });
    }

    if (outcome.passed) {
      sessionRecord.completed += 1;
    } else {
      sessionRecord.failed += 1;
    }
    sessionRecord.consumedRuntimeSeconds += Math.ceil(located.record.validation.durationMs / 1000);
    sessionRecord.lastOutcomeCode = outcome.code;
    await writeJsonAtomic(located.session.sessionFile, sessionRecord);

    if (!sessionRecord.policy.retainUntilVerified) {
      await cleanupTaskRun(located.session, runId);
    }
    return outcome;
  }

  async sessionStatus(sessionId: string): Promise<GenericSessionStatus> {
    const { paths, record } = await this.#loadSession(sessionId);
    await this.#expireIfNeeded(paths, record);
    return this.#status(record);
  }

  async stopSession(sessionId: string): Promise<GenericSessionStatus> {
    const { paths, record } = await this.#loadSession(sessionId);
    if (record.state === "active" || record.state === "draining") {
      record.state = transitionSession(record.state, "revoked");
      await writeJsonAtomic(paths.sessionFile, record);
    } else if (record.state === "awaiting_session_consent") {
      record.state = transitionSession(record.state, "closed");
      await writeJsonAtomic(paths.sessionFile, record);
    }
    const status = this.#status(record);
    await cleanupSession(this.#stateRoot, sessionId);
    return status;
  }

  async #loadSession(sessionId: string): Promise<{ paths: SessionPaths; record: SessionRecord }> {
    const paths = getSessionPaths(this.#stateRoot, sessionId);
    const record = await readJson<SessionRecord>(paths.sessionFile);
    if (record.sessionId !== sessionId) {
      throw new Error("Session record identifier mismatch");
    }
    return { paths, record };
  }

  async #expireIfNeeded(paths: SessionPaths, record: SessionRecord): Promise<boolean> {
    if (
      record.state === "active" &&
      record.expiresAt !== null &&
      Date.parse(record.expiresAt) <= this.#now().getTime()
    ) {
      record.state = transitionSession(record.state, "expired");
      await writeJsonAtomic(paths.sessionFile, record);
    }
    return record.state === "expired" || record.state === "revoked" || record.state === "closed";
  }

  #assertTaskPolicy(session: SessionRecord, task: TaskDefinition): void {
    if (
      task.policy.maxRuntimeSeconds > session.policy.maxTaskRuntimeSeconds ||
      task.policy.maxRuntimeSeconds >
        session.policy.maxTotalRuntimeSeconds - session.consumedRuntimeSeconds ||
      task.policy.maxChangedFiles > session.policy.maxChangedFiles ||
      task.policy.maxPatchBytes > session.policy.maxPatchBytes
    ) {
      throw new Error("Task exceeds the active session policy");
    }
    const allowed = new Set(session.policy.allowedExecutables);
    for (const command of task.validation) {
      const executable = path.basename(command.argv[0]);
      if (!allowed.has(executable)) {
        throw new Error(`Validation executable is not allowed: ${executable}`);
      }
    }
  }

  async #findRun(runId: string): Promise<LocatedRun> {
    const sessionEntries = await readdir(this.#stateRoot, { withFileTypes: true });
    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const session = getSessionPaths(this.#stateRoot, entry.name);
      const run = getTaskRunPaths(session, runId);
      try {
        const record = await readJson<RunRecord>(run.runFile);
        if (record.runId === runId && record.sessionId === entry.name) {
          return { session, run, record };
        }
      } catch {
        // Continue searching other active sessions.
      }
    }
    throw new Error(`Unknown task run: ${runId}`);
  }

  #status(record: SessionRecord): GenericSessionStatus {
    const now = this.#now().getTime();
    const activatedAt = record.activatedAt === null ? now : Date.parse(record.activatedAt);
    const remainingByQueue = Math.max(0, record.taskFiles.length - record.nextTaskIndex);
    const remainingByPolicy = Math.max(0, record.policy.maxTasks - record.completed - record.failed);
    return {
      sessionId: record.sessionId,
      state: record.state,
      completed: record.completed,
      failed: record.failed,
      remaining: Math.min(remainingByQueue, remainingByPolicy),
      elapsedSeconds: Math.max(0, Math.floor((now - activatedAt) / 1000)),
      remainingRuntimeSeconds: Math.max(
        0,
        record.policy.maxTotalRuntimeSeconds - record.consumedRuntimeSeconds
      ),
      lastOutcomeCode: record.lastOutcomeCode
    };
  }
}
