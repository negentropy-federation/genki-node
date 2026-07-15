import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";

interface AgySession {
  sessionId: string;
  sessionRoot: string;
  agyLogPath: string;
  model: string | null;
}

interface RunAgyInput {
  command?: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

export class AgyLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgyLaunchError";
  }
}

export function buildAgyArgs(session: AgySession): string[] {
  const args = [
    "--sandbox",
    "--new-project",
    "--add-dir",
    session.sessionRoot,
    "--log-file",
    session.agyLogPath
  ];
  if (session.model !== null) {
    args.push("--model", session.model);
  }
  args.push(
    "--prompt-interactive",
    `Continue the active Genki contribution session ${session.sessionId} using the genki-contribution skill.`
  );
  return args;
}

export async function runAgy(input: RunAgyInput): Promise<number> {
  const command = input.command ?? "agy";
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, input.args, {
      env: input.environment,
      shell: false,
      stdio: input.stdio ?? "inherit"
    });
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(new AgyLaunchError(`Unable to launch ${command}: ${error.message}`));
      }
    });
    child.once("close", (exitCode) => {
      if (!settled) {
        settled = true;
        resolve(exitCode ?? 1);
      }
    });
  });
}
