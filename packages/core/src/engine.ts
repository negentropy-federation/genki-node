import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { cleanupSession, cleanupTaskRun } from "./cleanup.js";
import { sha256Digest } from "./digest.js";
import { buildChildEnvironment } from "./environment.js";
import {
  applyCheckpoint,
  buildPatch,
  cloneRepository,
  inspectRepository,
  isRepositoryClean
} from "./repository.js";
import { persistRetainedCheckpoint, persistRetainedResult } from "./result.js";
import {
  parsePartialCheckpoint,
  parseSessionPolicy,
  parseTaskDefinition
} from "./schema.js";
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
  BoundedValidationSummary,
  GenericSessionStatus,
  GenericTaskOutcome,
  HostRunResult,
  LeasedTask,
  PartialCheckpoint,
  PatchSummary,
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
  taskId: string;
  taskRevision: number;
  attemptId: string;
  leaseId: string;
  leaseGeneration: number;
  host: SessionPolicy["host"];
  hostResult: HostRunResult | null;
  taskDigest: string;
  baseCommit: string;
  validation: ValidationSummary | null;
  sourcePath: string;
}

interface LocatedRun {
  session: SessionPaths;
  run: TaskRunPaths;
  record: RunRecord;
}

export interface PreparedLeasedTask extends PreparedTaskForHost {
  attemptId: string;
  leaseId: string;
  leaseGeneration: number;
  taskId: string;
  taskRevision: number;
  baseCommit: string;
  temporaryHome: string;
  runRoot: string;
}

export interface MaterializedRunResult {
  outcome: GenericTaskOutcome;
  patch: PatchSummary;
  validation: ValidationSummary;
  boundedValidation: BoundedValidationSummary;
  taskId: string;
  taskRevision: number;
  attemptId: string;
  leaseId: string;
  leaseGeneration: number;
  baseCommit: string;
}

export interface PrepareLeasedTaskInput {
  sessionId: string;
  leased: LeasedTask;
  localRepositoryPath: string;
  predecessor?: PartialCheckpoint | null;
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
        const attemptId = this.#createId();
        const leaseId = this.#createId();
        const runPaths = await createTaskRunStorage(paths, runId);
        const safeTask = { ...task, repository: { ...task.repository, path: "/REDACTED" } };
        await writeJsonAtomic(path.join(runPaths.root, "task.json"), safeTask);
        await cloneRepository(inspection, runPaths.workspace);
        const runRecord: RunRecord = {
          runId,
          sessionId,
          state: transitionTask("policy_checked", "prepared"),
          taskId: task.id,
          taskRevision: 1,
          attemptId,
          leaseId,
          leaseGeneration: 1,
          host: record.policy.host,
          hostResult: null,
          taskDigest: sha256Digest({ task, baseCommit: inspection.baseCommit }),
          baseCommit: inspection.baseCommit,
          validation: null,
          sourcePath: inspection.sourcePath
        };
        // Persist provenance before any host process launches so crash recovery
        // can locate the active run without a model conversation.
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

  async prepareLeasedTask(input: PrepareLeasedTaskInput): Promise<PreparedLeasedTask> {
    const { paths, record } = await this.#loadSession(input.sessionId);
    if (await this.#expireIfNeeded(paths, record)) {
      throw new Error("Session is not active");
    }
    if (record.state !== "active") {
      throw new Error("Session is not active");
    }
    if (
      record.completed + record.failed >= record.policy.maxTasks ||
      input.leased.policy.maxRuntimeSeconds > record.policy.maxTaskRuntimeSeconds ||
      input.leased.policy.maxRuntimeSeconds >
        record.policy.maxTotalRuntimeSeconds - record.consumedRuntimeSeconds ||
      input.leased.policy.maxChangedFiles > record.policy.maxChangedFiles ||
      input.leased.policy.maxPatchBytes > record.policy.maxPatchBytes
    ) {
      throw new Error("Leased task exceeds the active session policy");
    }
    const allowed = new Set(record.policy.allowedExecutables);
    for (const command of input.leased.validation) {
      const executable = path.basename(command.argv[0]);
      if (!allowed.has(executable)) {
        throw new Error(`Validation executable is not allowed: ${executable}`);
      }
    }

    const localTask: TaskDefinition = {
      schemaVersion: "1",
      id: input.leased.taskId,
      title: "leased-task",
      repository: {
        path: path.resolve(input.localRepositoryPath),
        baseRef: input.leased.project.baseCommit
      },
      instructions: input.leased.goal,
      validation: input.leased.validation,
      policy: {
        maxRuntimeSeconds: input.leased.policy.maxRuntimeSeconds,
        maxChangedFiles: input.leased.policy.maxChangedFiles,
        maxPatchBytes: input.leased.policy.maxPatchBytes
      }
    };
    const inspection = await inspectRepository(localTask);
    if (inspection.baseCommit !== input.leased.project.baseCommit) {
      throw new Error("Local repository base commit does not match the leased task");
    }

    const runId = this.#createId();
    const attemptId = this.#createId();
    const runPaths = await createTaskRunStorage(paths, runId);
    const safeTask = { ...localTask, repository: { ...localTask.repository, path: "/REDACTED" } };
    await writeJsonAtomic(path.join(runPaths.root, "task.json"), safeTask);
    await writeJsonAtomic(path.join(runPaths.root, "leased-task.json"), input.leased);
    await cloneRepository(inspection, runPaths.workspace);
    if (input.predecessor) {
      await applyCheckpoint(runPaths.workspace, input.predecessor);
    }

    const runRecord: RunRecord = {
      runId,
      sessionId: input.sessionId,
      state: transitionTask("policy_checked", "prepared"),
      taskId: input.leased.taskId,
      taskRevision: input.leased.revision,
      attemptId,
      leaseId: input.leased.leaseId,
      leaseGeneration: input.leased.leaseGeneration,
      host: record.policy.host,
      hostResult: null,
      taskDigest: sha256Digest({
        task: input.leased,
        baseCommit: inspection.baseCommit
      }),
      baseCommit: inspection.baseCommit,
      validation: null,
      sourcePath: inspection.sourcePath
    };
    runRecord.state = transitionTask(runRecord.state, "executing");
    await writeJsonAtomic(runPaths.runFile, runRecord);
    await writeJsonAtomic(paths.sessionFile, record);
    return {
      runId,
      workspace: runPaths.workspace,
      instructions: input.leased.goal,
      attemptId,
      leaseId: input.leased.leaseId,
      leaseGeneration: input.leased.leaseGeneration,
      taskId: input.leased.taskId,
      taskRevision: input.leased.revision,
      baseCommit: inspection.baseCommit,
      temporaryHome: runPaths.temporaryHome,
      runRoot: runPaths.root
    };
  }

  async inspectPatch(runId: string): Promise<PatchSummary> {
    const located = await this.#findRun(runId);
    return buildPatch(located.run.workspace);
  }

  async materializeResult(runId: string): Promise<MaterializedRunResult> {
    const located = await this.#findRun(runId);
    if (located.record.state !== "finalizing" || located.record.validation === null) {
      throw new Error("Run is not ready for finalization");
    }
    const task = parseTaskDefinition(await readJson(path.join(located.run.root, "task.json")));
    const patch = await buildPatch(located.run.workspace);
    const { paths: sessionPaths, record: sessionRecord } = await this.#loadSession(
      located.record.sessionId
    );
    const exceedsPolicy =
      patch.changedFiles.length > task.policy.maxChangedFiles ||
      patch.changedFiles.length > sessionRecord.policy.maxChangedFiles ||
      patch.patchBytes > task.policy.maxPatchBytes ||
      patch.patchBytes > sessionRecord.policy.maxPatchBytes;

    const isClean = await isRepositoryClean(located.record.sourcePath);

    let outcome: GenericTaskOutcome;
    if (!isClean) {
      located.record.state = transitionTask(located.record.state, "failed");
      outcome = { code: "SOURCE_CONTAMINATION", passed: false };
    } else if (exceedsPolicy) {
      located.record.state = transitionTask(located.record.state, "frozen");
      outcome = { code: "POLICY_FROZEN", passed: false };
    } else if (!located.record.validation.passed) {
      located.record.state = transitionTask(located.record.state, "failed");
      outcome = { code: "VALIDATION_FAILED", passed: false };
    } else {
      located.record.state = transitionTask(located.record.state, "uploading_result");
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
    await writeJsonAtomic(sessionPaths.sessionFile, sessionRecord);

    return {
      outcome,
      patch,
      validation: located.record.validation,
      boundedValidation: toBoundedValidationSummary(located.record.validation),
      taskId: located.record.taskId,
      taskRevision: located.record.taskRevision,
      attemptId: located.record.attemptId,
      leaseId: located.record.leaseId,
      leaseGeneration: located.record.leaseGeneration,
      baseCommit: located.record.baseCommit
    };
  }

  async purgeRun(runId: string): Promise<void> {
    // Idempotent: a second purge after the run directory is gone is a no-op.
    try {
      const located = await this.#findRun(runId);
      const { record: sessionRecord } = await this.#loadSession(located.record.sessionId);
      if (!sessionRecord.policy.retainUntilVerified) {
        await cleanupTaskRun(located.session, runId);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown task run:")) {
        return;
      }
      throw error;
    }
  }

  async noteSessionOutcome(
    sessionId: string,
    outcome: { failed?: boolean; lastOutcomeCode: string; runtimeSeconds?: number }
  ): Promise<void> {
    const { paths, record } = await this.#loadSession(sessionId);
    if (outcome.failed) {
      record.failed += 1;
    }
    if (outcome.runtimeSeconds !== undefined) {
      record.consumedRuntimeSeconds += outcome.runtimeSeconds;
    }
    record.lastOutcomeCode = outcome.lastOutcomeCode;
    await writeJsonAtomic(paths.sessionFile, record);
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

  async recordHostCompletion(runId: string, hostResult: HostRunResult): Promise<void> {
    const located = await this.#findRun(runId);
    if (located.record.state !== "executing") {
      throw new Error("Host completion can only be recorded while the run is executing");
    }
    if (located.record.hostResult !== null) {
      throw new Error("Host result was already recorded for this run");
    }
    if (hostResult.host !== located.record.host) {
      throw new Error("Host result does not match the session host");
    }
    located.record.hostResult = hostResult;
    await writeJsonAtomic(located.run.runFile, located.record);
  }

  async checkpointRun(runId: string, hostResult: HostRunResult): Promise<PartialCheckpoint> {
    const located = await this.#findRun(runId);
    if (located.record.state !== "executing") {
      throw new Error("Checkpoints can only be captured from an executing run");
    }
    if (hostResult.host !== located.record.host) {
      throw new Error("Host result does not match the session host");
    }
    if (located.record.hostResult === null) {
      located.record.hostResult = hostResult;
    } else if (
      located.record.hostResult.outcome !== hostResult.outcome ||
      located.record.hostResult.host !== hostResult.host
    ) {
      throw new Error("Host result conflicts with the recorded host completion");
    }

    located.record.state = transitionTask(located.record.state, "checkpointing");
    await writeJsonAtomic(located.run.runFile, located.record);

    const task = parseTaskDefinition(await readJson(path.join(located.run.root, "task.json")));
    const patch = await buildPatch(located.run.workspace);
    const { paths: sessionPaths, record: sessionRecord } = await this.#loadSession(
      located.record.sessionId
    );
    const exceedsPolicy =
      patch.changedFiles.length === 0 ||
      patch.changedFiles.length > task.policy.maxChangedFiles ||
      patch.changedFiles.length > sessionRecord.policy.maxChangedFiles ||
      patch.patchBytes > task.policy.maxPatchBytes ||
      patch.patchBytes > sessionRecord.policy.maxPatchBytes;

    const isClean = await isRepositoryClean(located.record.sourcePath);
    if (!isClean) {
      located.record.state = transitionTask(located.record.state, "frozen");
      await writeJsonAtomic(located.run.runFile, located.record);
      sessionRecord.failed += 1;
      sessionRecord.lastOutcomeCode = "SOURCE_CONTAMINATION";
      await writeJsonAtomic(sessionPaths.sessionFile, sessionRecord);
      throw new Error("Checkpoint rejected due to source repository contamination");
    }

    if (exceedsPolicy) {
      located.record.state = transitionTask(located.record.state, "frozen");
      await writeJsonAtomic(located.run.runFile, located.record);
      sessionRecord.failed += 1;
      sessionRecord.lastOutcomeCode = "POLICY_FROZEN";
      await writeJsonAtomic(sessionPaths.sessionFile, sessionRecord);
      throw new Error("Checkpoint patch exceeds the active session or task policy");
    }

    const checkpoint = parsePartialCheckpoint({
      schemaVersion: "1",
      taskId: located.record.taskId,
      taskRevision: located.record.taskRevision,
      attemptId: located.record.attemptId,
      leaseId: located.record.leaseId,
      leaseGeneration: located.record.leaseGeneration,
      baseCommit: located.record.baseCommit,
      patch: patch.patch,
      patchDigest: patch.patchDigest,
      changedFiles: patch.changedFiles,
      validation:
        located.record.validation === null
          ? null
          : toBoundedValidationSummary(located.record.validation),
      host: hostResult.host,
      hostOutcome: hostResult.outcome,
      completedCriteria: [...hostResult.completedCriteria],
      remainingCriteria: [...hostResult.remainingCriteria],
      createdAt: this.#now().toISOString()
    });

    located.record.state = transitionTask(located.record.state, "uploading_checkpoint");
    located.record.state = transitionTask(located.record.state, "checkpointed");
    await writeJsonAtomic(located.run.runFile, located.record);

    if (sessionRecord.policy.retainUntilVerified) {
      await persistRetainedCheckpoint({
        runRoot: located.run.root,
        checkpoint
      });
    }

    sessionRecord.lastOutcomeCode = hostResult.outcome.toUpperCase();
    await writeJsonAtomic(sessionPaths.sessionFile, sessionRecord);
    return checkpoint;
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

    const isClean = await isRepositoryClean(located.record.sourcePath);

    let outcome: GenericTaskOutcome;
    if (!isClean) {
      located.record.state = transitionTask(located.record.state, "failed");
      outcome = { code: "SOURCE_CONTAMINATION", passed: false };
    } else if (exceedsPolicy) {
      located.record.state = transitionTask(located.record.state, "frozen");
      outcome = { code: "POLICY_FROZEN", passed: false };
    } else if (!located.record.validation.passed) {
      located.record.state = transitionTask(located.record.state, "failed");
      outcome = { code: "VALIDATION_FAILED", passed: false };
    } else {
      located.record.state = transitionTask(located.record.state, "uploading_result");
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

function toBoundedValidationSummary(validation: ValidationSummary): BoundedValidationSummary {
  return {
    passed: validation.passed,
    durationMs: validation.durationMs,
    commands: validation.commands.map((command) => ({
      executable: path.basename(command.argv[0] ?? "unknown"),
      exitCode:
        command.exitCode === null
          ? null
          : Math.min(255, Math.max(0, command.exitCode)),
      timedOut: command.timedOut,
      durationMs: command.durationMs
    }))
  };
}
