import { createHash } from "node:crypto";
import path from "node:path";

import type { CoordinatorClient, LocalCoordinator } from "../../coordinator/src/index.js";
import type { GenkiEngine } from "../../core/src/engine.js";
import type {
  GenericSessionStatus,
  HostRunResult,
  LeasedTask,
  PartialCheckpoint,
  SessionPolicy
} from "../../core/src/types.js";
import type { HostAdapter } from "../../hosts/src/types.js";

export interface ContributionSessionInput {
  engine: GenkiEngine;
  coordinator: CoordinatorClient;
  host: HostAdapter;
  sessionId: string;
  policy: SessionPolicy;
  policyDigest: string;
  resolveLocalRepository: (task: LeasedTask) => string;
  getAcceptedCheckpoint?: (taskId: string) => PartialCheckpoint | null;
  abortSignal?: AbortSignal;
  onStatus?: (status: GenericSessionStatus) => void;
  createOperationId?: (parts: string[]) => string;
}

export interface ContributionSessionSummary {
  sessionId: string;
  completed: number;
  failed: number;
  lastOutcomeCode: string | null;
  stopped: boolean;
}

function operationId(parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function emptyPatchDigest(): string {
  return createHash("sha256").update("").digest("hex");
}

function isLocalCoordinator(
  coordinator: CoordinatorClient
): coordinator is LocalCoordinator {
  return typeof (coordinator as LocalCoordinator).resolveLocalRepository === "function";
}

export async function runContributionSession(
  input: ContributionSessionInput
): Promise<ContributionSessionSummary> {
  const createOpId = input.createOperationId ?? operationId;
  const sessionAbort = input.abortSignal ?? new AbortController().signal;
  let stopped = false;

  const onAbort = (): void => {
    stopped = true;
  };
  sessionAbort.addEventListener("abort", onAbort, { once: true });

  const coordinatorSession = await input.coordinator.openSession({
    policyDigest: input.policyDigest,
    host: input.policy.host,
    contributor: { displayName: null, slogan: null, email: null }
  });

  try {
    while (!stopped && !sessionAbort.aborted) {
      const status = await input.engine.sessionStatus(input.sessionId);
      input.onStatus?.(status);
      if (status.state !== "active" || status.remainingRuntimeSeconds <= 0) {
        break;
      }
      if (status.completed + status.failed >= input.policy.maxTasks) {
        break;
      }

      const leased = await input.coordinator.leaseTask(coordinatorSession);
      if (leased === null) {
        break;
      }

      const taskAbort = new AbortController();
      const forwardAbort = (): void => {
        taskAbort.abort();
      };
      sessionAbort.addEventListener("abort", forwardAbort, { once: true });

      const heartbeatMs = Math.max(
        1_000,
        Math.floor((Date.parse(leased.leaseExpiresAt) - Date.now()) / 3)
      );
      const heartbeatTimer = setInterval(() => {
        void input.coordinator
          .heartbeat({
            sessionId: coordinatorSession.sessionId,
            token: coordinatorSession.token,
            leaseId: leased.leaseId,
            leaseGeneration: leased.leaseGeneration
          })
          .catch(() => {
            taskAbort.abort();
          });
      }, heartbeatMs);

      try {
        const localRepositoryPath = input.resolveLocalRepository(leased);
        const predecessor =
          input.getAcceptedCheckpoint?.(leased.taskId) ??
          (isLocalCoordinator(input.coordinator)
            ? input.coordinator.getAcceptedCheckpoint(leased.taskId)
            : null);

        const prepared = await input.engine.prepareLeasedTask({
          sessionId: input.sessionId,
          leased,
          localRepositoryPath,
          predecessor
        });

        const hostResult = await input.host.runTask({
          sessionId: input.sessionId,
          taskId: prepared.taskId,
          attemptId: prepared.attemptId,
          workspace: prepared.workspace,
          instructions: prepared.instructions,
          model: input.policy.model,
          timeoutSeconds: input.policy.maxTaskRuntimeSeconds,
          temporaryHome: prepared.temporaryHome,
          abortSignal: taskAbort.signal
        });

        clearInterval(heartbeatTimer);
        sessionAbort.removeEventListener("abort", forwardAbort);

        await input.engine.recordHostCompletion(prepared.runId, hostResult);

        if (hostResult.outcome === "completed") {
          await input.engine.runValidation(prepared.runId);
          const materialized = await input.engine.materializeResult(prepared.runId);
          const ack = await input.coordinator.uploadResult({
            sessionId: coordinatorSession.sessionId,
            token: coordinatorSession.token,
            leaseId: leased.leaseId,
            leaseGeneration: leased.leaseGeneration,
            operationId: createOpId([
              coordinatorSession.sessionId,
              leased.taskId,
              prepared.attemptId,
              String(leased.leaseGeneration),
              "result"
            ]),
            taskId: materialized.taskId,
            taskRevision: materialized.taskRevision,
            attemptId: materialized.attemptId,
            baseCommit: materialized.baseCommit,
            patch: materialized.patch.patch,
            patchDigest: materialized.patch.patchDigest,
            changedFiles: materialized.patch.changedFiles,
            validation: materialized.boundedValidation,
            host: hostResult.host,
            hostOutcome: hostResult.outcome,
            usage: hostResult.usage,
            completedCriteria: hostResult.completedCriteria,
            remainingCriteria: hostResult.remainingCriteria,
            kind: "result"
          });
          if (ack.reason === "stale_lease") {
            // Discard local result; do not retry as a new generation.
          }
          await input.engine.purgeRun(prepared.runId);
          continue;
        }

        const patch = await input.engine.inspectPatch(prepared.runId);
        if (patch.changedFiles.length > 0 && patch.patchBytes > 0) {
          let checkpoint: PartialCheckpoint;
          try {
            checkpoint = await input.engine.checkpointRun(prepared.runId, hostResult);
          } catch {
            await input.engine.purgeRun(prepared.runId);
            continue;
          }
          const ack = await input.coordinator.uploadCheckpoint({
            sessionId: coordinatorSession.sessionId,
            token: coordinatorSession.token,
            leaseId: leased.leaseId,
            leaseGeneration: leased.leaseGeneration,
            operationId: createOpId([
              coordinatorSession.sessionId,
              leased.taskId,
              prepared.attemptId,
              String(leased.leaseGeneration),
              "checkpoint"
            ]),
            checkpoint
          });
          if (ack.reason === "stale_lease") {
            // Drop the checkpoint for the expired generation.
          }
          await input.engine.purgeRun(prepared.runId);
          continue;
        }

        const ack = await input.coordinator.uploadResult({
          sessionId: coordinatorSession.sessionId,
          token: coordinatorSession.token,
          leaseId: leased.leaseId,
          leaseGeneration: leased.leaseGeneration,
          operationId: createOpId([
            coordinatorSession.sessionId,
            leased.taskId,
            prepared.attemptId,
            String(leased.leaseGeneration),
            "attempt"
          ]),
          taskId: prepared.taskId,
          taskRevision: prepared.taskRevision,
          attemptId: prepared.attemptId,
          baseCommit: prepared.baseCommit,
          patch: "",
          patchDigest: emptyPatchDigest(),
          changedFiles: [],
          validation: null,
          host: hostResult.host,
          hostOutcome: hostResult.outcome,
          usage: hostResult.usage,
          completedCriteria: hostResult.completedCriteria,
          remainingCriteria: hostResult.remainingCriteria,
          kind: "attempt_evidence"
        });
        if (ack.accepted || ack.reason === "duplicate") {
          await input.engine.noteSessionOutcome(input.sessionId, {
            failed: true,
            lastOutcomeCode: hostResult.outcome.toUpperCase()
          });
        }
        await input.engine.purgeRun(prepared.runId);
      } catch {
        clearInterval(heartbeatTimer);
        sessionAbort.removeEventListener("abort", forwardAbort);
        if (sessionAbort.aborted) {
          stopped = true;
          break;
        }
        await input.engine.noteSessionOutcome(input.sessionId, {
          failed: true,
          lastOutcomeCode: "TASK_FAILED"
        });
      } finally {
        clearInterval(heartbeatTimer);
        sessionAbort.removeEventListener("abort", forwardAbort);
      }
    }
  } finally {
    sessionAbort.removeEventListener("abort", onAbort);
    try {
      await input.coordinator.closeSession({
        sessionId: coordinatorSession.sessionId,
        token: coordinatorSession.token
      });
    } catch {
      // Best-effort close.
    }
  }

  const finalStatus = await input.engine.sessionStatus(input.sessionId);
  return {
    sessionId: input.sessionId,
    completed: finalStatus.completed,
    failed: finalStatus.failed,
    lastOutcomeCode: finalStatus.lastOutcomeCode,
    stopped: stopped || sessionAbort.aborted
  };
}

export function defaultLocalRepositoryResolver(
  coordinator: LocalCoordinator
): (task: LeasedTask) => string {
  return (task) => coordinator.resolveLocalRepository(task);
}

export function logPathForRun(runRoot: string, host: string): string {
  return path.join(runRoot, `${host}.log`);
}

export type { HostRunResult };
