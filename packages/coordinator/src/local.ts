import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseTaskDefinition } from "../../core/src/schema.js";
import type {
  LeasedTask,
  PartialCheckpoint,
  TaskDefinition
} from "../../core/src/types.js";
import type {
  CheckpointUpload,
  CloseSessionInput,
  CoordinatorClient,
  CoordinatorSession,
  LeaseHeartbeat,
  LeaseStatus,
  OpenSessionInput,
  ResultUpload,
  UploadAck
} from "./types.js";

const execFileAsync = promisify(execFile);

interface QueuedTask {
  filename: string;
  definition: TaskDefinition;
  baseCommit: string;
  generations: number;
  acceptedCheckpoint: PartialCheckpoint | null;
  terminalAccepted: boolean;
}

interface ActiveLease {
  leaseId: string;
  leaseGeneration: number;
  taskIndex: number;
  expiresAt: string;
  sessionId: string;
}

interface OpenLocalSession {
  sessionId: string;
  token: string;
  expiresAt: string;
  closed: boolean;
  host: OpenSessionInput["policy"]["host"];
  policyDigest: string;
}

interface StoredOperation {
  operationId: string;
  kind: "checkpoint" | "result" | "attempt_evidence";
  leaseId: string;
  leaseGeneration: number;
  payload: CheckpointUpload | ResultUpload;
}

export interface LocalCoordinatorOptions {
  taskDirectory: string;
  now?: () => Date;
  createId?: () => string;
  leaseDurationSeconds?: number;
  normalSignal?: number;
  dailyAttemptSignalCap?: number;
}

export class LocalCoordinator implements CoordinatorClient {
  readonly #taskDirectory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #leaseDurationSeconds: number;
  readonly #normalSignal: number;
  readonly #dailyAttemptSignalCap: number;
  readonly #queue: QueuedTask[] = [];
  readonly #sessions = new Map<string, OpenLocalSession>();
  readonly #tokens = new Map<string, string>();
  readonly #operations = new Map<string, StoredOperation>();
  readonly #attemptAwards: Array<{ operationId: string; award: number }> = [];
  #activeLease: ActiveLease | null = null;
  #loaded = false;

  constructor(options: LocalCoordinatorOptions) {
    this.#taskDirectory = path.resolve(options.taskDirectory);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#leaseDurationSeconds = options.leaseDurationSeconds ?? 1_800;
    this.#normalSignal = options.normalSignal ?? 100;
    this.#dailyAttemptSignalCap = options.dailyAttemptSignalCap ?? 5;
  }

  async openSession(input: OpenSessionInput): Promise<CoordinatorSession> {
    await this.#ensureLoaded();
    const sessionId = this.#createId();
    const token = this.#createId();
    const expiresAt = new Date(this.#now().getTime() + 8 * 3600 * 1000).toISOString();
    const session: OpenLocalSession = {
      sessionId,
      token,
      expiresAt,
      closed: false,
      host: input.policy.host,
      policyDigest: input.policyDigest
    };
    this.#sessions.set(sessionId, session);
    this.#tokens.set(token, sessionId);
    return { sessionId, token, expiresAt };
  }

  async leaseTask(session: CoordinatorSession): Promise<LeasedTask | null> {
    await this.#ensureLoaded();
    this.#assertOpen(session);
    this.#expireActiveLeaseIfNeeded();

    if (this.#activeLease !== null && this.#activeLease.sessionId === session.sessionId) {
      const task = this.#queue[this.#activeLease.taskIndex];
      if (task === undefined || task.terminalAccepted) {
        this.#activeLease = null;
      } else {
        return this.#toLeasedTask(task, this.#activeLease);
      }
    }

    if (this.#activeLease !== null) {
      // Another session still holds the active lease.
      return null;
    }

    // Prefer never-checkpointed work first so one interrupted task does not
    // starve the rest of the local queue. Checkpointed tasks remain available
    // for continuation after other pending items.
    const candidates: number[] = [];
    const continuation: number[] = [];
    for (let index = 0; index < this.#queue.length; index += 1) {
      const task = this.#queue[index];
      if (task === undefined || task.terminalAccepted) {
        continue;
      }
      if (task.acceptedCheckpoint === null) {
        candidates.push(index);
      } else {
        continuation.push(index);
      }
    }
    for (const index of [...candidates, ...continuation]) {
      const task = this.#queue[index];
      if (task === undefined) {
        continue;
      }
      task.generations += 1;
      const lease: ActiveLease = {
        leaseId: this.#createId(),
        leaseGeneration: task.generations,
        taskIndex: index,
        expiresAt: new Date(
          this.#now().getTime() + this.#leaseDurationSeconds * 1000
        ).toISOString(),
        sessionId: session.sessionId
      };
      this.#activeLease = lease;
      return this.#toLeasedTask(task, lease);
    }
    return null;
  }

  async heartbeat(input: LeaseHeartbeat): Promise<LeaseStatus> {
    this.#assertOpen({ sessionId: input.sessionId, token: input.token });
    this.#expireActiveLeaseIfNeeded();
    const lease = this.#activeLease;
    if (
      lease === null ||
      lease.leaseId !== input.leaseId ||
      lease.leaseGeneration !== input.leaseGeneration ||
      lease.sessionId !== input.sessionId
    ) {
      return {
        leaseId: input.leaseId,
        leaseGeneration: input.leaseGeneration,
        active: false,
        expiresAt: this.#now().toISOString()
      };
    }
    lease.expiresAt = new Date(
      this.#now().getTime() + this.#leaseDurationSeconds * 1000
    ).toISOString();
    return {
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      active: true,
      expiresAt: lease.expiresAt
    };
  }

  async uploadCheckpoint(input: CheckpointUpload): Promise<UploadAck> {
    const session = this.#assertOpen({
      sessionId: input.sessionId,
      token: input.token
    });
    if (session.closed) {
      return { accepted: false, operationId: input.operationId, reason: "session_closed" };
    }
    const existing = this.#operations.get(input.operationId);
    if (existing !== undefined) {
      return { accepted: true, operationId: input.operationId, reason: "duplicate" };
    }
    this.#expireActiveLeaseIfNeeded();
    if (!this.#leaseMatches(input.leaseId, input.leaseGeneration, input.sessionId)) {
      return { accepted: false, operationId: input.operationId, reason: "stale_lease" };
    }
    const task = this.#queue[this.#activeLease!.taskIndex];
    if (task === undefined) {
      return { accepted: false, operationId: input.operationId, reason: "policy_rejected" };
    }
    task.acceptedCheckpoint = input.checkpoint;
    this.#operations.set(input.operationId, {
      operationId: input.operationId,
      kind: "checkpoint",
      leaseId: input.leaseId,
      leaseGeneration: input.leaseGeneration,
      payload: input
    });
    this.#activeLease = null;
    return { accepted: true, operationId: input.operationId, reason: "accepted" };
  }

  async uploadResult(input: ResultUpload): Promise<UploadAck> {
    const session = this.#assertOpen({
      sessionId: input.sessionId,
      token: input.token
    });
    if (session.closed) {
      return { accepted: false, operationId: input.operationId, reason: "session_closed" };
    }
    const existing = this.#operations.get(input.operationId);
    if (existing !== undefined) {
      return { accepted: true, operationId: input.operationId, reason: "duplicate" };
    }
    this.#expireActiveLeaseIfNeeded();
    if (!this.#leaseMatches(input.leaseId, input.leaseGeneration, input.sessionId)) {
      return { accepted: false, operationId: input.operationId, reason: "stale_lease" };
    }
    const task = this.#queue[this.#activeLease!.taskIndex];
    if (task === undefined) {
      return { accepted: false, operationId: input.operationId, reason: "policy_rejected" };
    }

    if (input.kind === "attempt_evidence") {
      const award = Math.min(this.#normalSignal * 0.01, this.#dailyAttemptSignalCap);
      this.#attemptAwards.push({ operationId: input.operationId, award });
    } else {
      task.terminalAccepted = true;
      task.acceptedCheckpoint = null;
    }

    this.#operations.set(input.operationId, {
      operationId: input.operationId,
      kind: input.kind === "attempt_evidence" ? "attempt_evidence" : "result",
      leaseId: input.leaseId,
      leaseGeneration: input.leaseGeneration,
      payload: input
    });
    this.#activeLease = null;
    return { accepted: true, operationId: input.operationId, reason: "accepted" };
  }

  async closeSession(input: CloseSessionInput): Promise<void> {
    const session = this.#assertOpen({
      sessionId: input.sessionId,
      token: input.token
    });
    session.closed = true;
    if (this.#activeLease?.sessionId === input.sessionId) {
      this.#activeLease = null;
    }
  }

  /** Test/inspection helpers — not part of CoordinatorClient. */
  resolveLocalRepository(task: LeasedTask): string {
    const queued = this.#queue.find((entry) => entry.definition.id === task.taskId);
    if (queued === undefined) {
      throw new Error(`Unknown local task: ${task.taskId}`);
    }
    return queued.definition.repository.path;
  }

  getAcceptedCheckpoint(taskId: string): PartialCheckpoint | null {
    return this.#queue.find((entry) => entry.definition.id === taskId)?.acceptedCheckpoint ?? null;
  }

  listOperations(): StoredOperation[] {
    return [...this.#operations.values()];
  }

  listAttemptAwards(): Array<{ operationId: string; award: number }> {
    return [...this.#attemptAwards];
  }

  expireActiveLeaseNow(): void {
    if (this.#activeLease !== null) {
      this.#activeLease.expiresAt = new Date(this.#now().getTime() - 1).toISOString();
    }
    this.#expireActiveLeaseIfNeeded();
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    const files = (await readdir(this.#taskDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
    for (const filename of files) {
      const absolute = path.join(this.#taskDirectory, filename);
      const definition = parseTaskDefinition(
        JSON.parse(await readFile(absolute, "utf8")) as unknown
      );
      const baseCommit = (
        await execFileAsync("git", ["rev-parse", `${definition.repository.baseRef}^{commit}`], {
          cwd: definition.repository.path,
          encoding: "utf8"
        })
      ).stdout.trim();
      this.#queue.push({
        filename,
        definition,
        baseCommit,
        generations: 0,
        acceptedCheckpoint: null,
        terminalAccepted: false
      });
    }
    this.#loaded = true;
  }

  #assertOpen(session: Pick<CoordinatorSession, "sessionId" | "token">): OpenLocalSession {
    const record = this.#sessions.get(session.sessionId);
    if (record === undefined || record.token !== session.token) {
      throw new Error("Unknown or unauthorized coordinator session");
    }
    if (record.closed) {
      throw new Error("Coordinator session is closed");
    }
    return record;
  }

  #expireActiveLeaseIfNeeded(): void {
    if (
      this.#activeLease !== null &&
      Date.parse(this.#activeLease.expiresAt) <= this.#now().getTime()
    ) {
      this.#activeLease = null;
    }
  }

  #leaseMatches(leaseId: string, generation: number, sessionId: string): boolean {
    return (
      this.#activeLease !== null &&
      this.#activeLease.leaseId === leaseId &&
      this.#activeLease.leaseGeneration === generation &&
      this.#activeLease.sessionId === sessionId
    );
  }

  #toLeasedTask(task: QueuedTask, lease: ActiveLease): LeasedTask {
    const predecessor =
      task.acceptedCheckpoint === null
        ? null
        : {
            checkpointId: createHash("sha256")
              .update(task.acceptedCheckpoint.patchDigest)
              .digest("hex")
              .slice(0, 32),
            baseCommit: task.acceptedCheckpoint.baseCommit,
            patchDigest: task.acceptedCheckpoint.patchDigest
          };
    return {
      schemaVersion: "2",
      taskId: task.definition.id,
      revision: 1,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      leaseExpiresAt: lease.expiresAt,
      project: {
        projectId: "local-fixture",
        repositoryUrl: "https://example.invalid/local-fixture.git",
        repositoryClass: "public",
        licenseSpdx: "MIT",
        baseCommit: task.baseCommit
      },
      goal: task.definition.instructions,
      acceptanceCriteria: [task.definition.title],
      validation: task.definition.validation,
      policy: {
        maxRuntimeSeconds: task.definition.policy.maxRuntimeSeconds,
        maxChangedFiles: task.definition.policy.maxChangedFiles,
        maxPatchBytes: task.definition.policy.maxPatchBytes,
        executionNetwork: "none",
        dependencyDomains: []
      },
      predecessorCheckpoint: predecessor
    };
  }
}
