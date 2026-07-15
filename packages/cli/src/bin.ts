#!/usr/bin/env node

import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GenkiEngine,
  cleanupExpiredSessions,
  cleanupSession
} from "../../core/src/index.js";
import { buildAgyArgs, runAgy } from "./agy.js";
import { CliUsageError, parseCliArgs } from "./args.js";
import { askForSessionConsent } from "./consent.js";

const help = `Genki Node

Usage:
  genki contribute --task-dir <path> [options]
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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
      process.stdout.write("Contribution mode active. Press Ctrl-C to stop.\n");
      try {
        const exitCode = await runAgy({
          args: buildAgyArgs({
            sessionId: description.sessionId,
            sessionRoot: description.sessionRoot,
            agyLogPath: description.agyLogPath,
            model: command.policy.model
          }),
          environment: {
            ...process.env,
            GENKI_STATE_ROOT: root,
            GENKI_SESSION_ID: description.sessionId
          }
        });
        if (!command.policy.retainUntilVerified && (await pathExists(description.sessionRoot))) {
          await engine.stopSession(description.sessionId);
          process.stdout.write("Contribution session closed. Local Genki artifacts cleared.\n");
        } else if (command.policy.retainUntilVerified) {
          process.stdout.write(
            `Developer retention enabled for session ${description.sessionId}. Run genki cleanup --session ${description.sessionId} after verification.\n`
          );
        }
        return exitCode;
      } catch (error) {
        if (await pathExists(description.sessionRoot)) {
          await cleanupSession(root, description.sessionId);
        }
        throw error;
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
