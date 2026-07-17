#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import {
  HttpCoordinatorClient,
  LocalCoordinator
} from "../../coordinator/src/index.js";
import {
  GenkiEngine,
  cleanupExpiredSessions,
  cleanupSession
} from "../../core/src/index.js";
import type { GenericSessionStatus, LeasedTask } from "../../core/src/types.js";
import { AgyHostAdapter, CodexHostAdapter } from "../../hosts/src/index.js";
import {
  runContributionSession,
  type ContributionSessionInput
} from "../../orchestrator/src/index.js";
import { CliUsageError, parseCliArgs } from "./args.js";
import { askForSessionConsent } from "./consent.js";

const help = `Genki Node

Usage:
  genki contribute --task-dir <path> [--host agy|codex] [--coordinator local|https://...] [options]
  genki status <session-id>
  genki stop <session-id>
  genki cleanup --session <session-id>
  genki cleanup --all-expired
`;

function stateRoot(): string {
  return path.resolve(
    process.env.GENKI_STATE_ROOT ??
      path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "genki-node")
  );
}

async function run(): Promise<number> {
  const command = parseCliArgs(process.argv.slice(2));
  const root = stateRoot();
  const engine = new GenkiEngine({ stateRoot: root });

  switch (command.command) {
    case "help":
      process.stdout.write(help);
      return 0;
    case "status":
      process.stdout.write(`${JSON.stringify(await engine.sessionStatus(command.sessionId))}\n`);
      return 0;
    case "stop":
      process.stdout.write(`${JSON.stringify(await engine.stopSession(command.sessionId))}\n`);
      return 0;
    case "cleanup-session": {
      const report = await cleanupSession(root, command.sessionId);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    }
    case "cleanup-expired": {
      const reports = await cleanupExpiredSessions(root, new Date());
      process.stdout.write(`${JSON.stringify({ cleaned: reports.length })}\n`);
      return 0;
    }
    case "contribute": {
      const description = await engine.describeSession({
        taskDirectory: command.taskDirectory,
        policy: command.policy
      });
      const consented = await askForSessionConsent(description.summary);
      if (!consented) {
        await cleanupSession(root, description.sessionId);
        process.stdout.write("Contribution session cancelled. Local Genki artifacts cleared.\n");
        return 0;
      }
      await engine.activateSession(description.sessionId, description.policyDigest);
      process.stdout.write(
        "Contribution mode active. Task details stay hidden by default. Press Ctrl-C to stop.\n"
      );

      const host =
        command.policy.host === "codex"
          ? new CodexHostAdapter()
          : new AgyHostAdapter();

      const coordinator =
        command.coordinator.kind === "local"
          ? new LocalCoordinator({ taskDirectory: command.taskDirectory })
          : new HttpCoordinatorClient({ baseUrl: command.coordinator.url });

      const controller = new AbortController();
      const onSignal = (): void => {
        controller.abort();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      try {
        const sessionInput: ContributionSessionInput = {
          engine,
          coordinator,
          host,
          sessionId: description.sessionId,
          policy: command.policy,
          policyDigest: description.policyDigest,
          resolveLocalRepository: (task: LeasedTask) => {
            if (!(coordinator instanceof LocalCoordinator)) {
              throw new Error(
                "Remote coordinator tasks require a local repository resolver; use --coordinator local for fixtures"
              );
            }
            return coordinator.resolveLocalRepository(task);
          },
          abortSignal: controller.signal,
          onStatus: (status: GenericSessionStatus) => {
            process.stdout.write(
              `${JSON.stringify({
                sessionId: status.sessionId,
                state: status.state,
                completed: status.completed,
                failed: status.failed,
                remaining: status.remaining,
                elapsedSeconds: status.elapsedSeconds,
                remainingRuntimeSeconds: status.remainingRuntimeSeconds,
                lastOutcomeCode: status.lastOutcomeCode
              })}\n`
            );
          }
        };
        if (coordinator instanceof LocalCoordinator) {
          sessionInput.getAcceptedCheckpoint = (taskId) =>
            coordinator.getAcceptedCheckpoint(taskId);
        }
        const summary = await runContributionSession(sessionInput);

        if (!command.policy.retainUntilVerified) {
          await engine.stopSession(description.sessionId);
          process.stdout.write(
            `Contribution session closed. completed=${summary.completed} failed=${summary.failed}. Local Genki artifacts cleared.\n`
          );
        } else {
          process.stdout.write(
            `Developer retention enabled for session ${description.sessionId}. Run genki cleanup --session ${description.sessionId} after verification.\n`
          );
        }
        return summary.failed > 0 && summary.completed === 0 ? 1 : 0;
      } catch (error) {
        await cleanupSession(root, description.sessionId).catch(() => undefined);
        throw error;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
  }
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${help}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`genki: ${message}\n`);
    }
    process.exitCode = 1;
  });
