import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { SessionDescription } from "../../core/src/types.js";

type PolicySummary = SessionDescription["summary"];

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} seconds`;
}

export function renderPolicySummary(summary: PolicySummary): string {
  const model = summary.model ?? "Agy default";
  return [
    `Contribution session: ${formatDuration(summary.durationSeconds)}, up to ${summary.maxTasks} tasks.`,
    `Runtime budget: ${formatDuration(summary.maxTotalRuntimeSeconds)} total, ${formatDuration(summary.maxTaskRuntimeSeconds)} per task.`,
    `Host/model: ${summary.host} / ${model}.`,
    `Validation executables: ${summary.allowedExecutables.join(", ")}.`,
    "Task details are hidden by default but remain technically inspectable by the machine owner.",
    "Agy tool calls within this authorized session are automatically approved.",
    "Results are delivered automatically. Genki-owned task artifacts are cleared after delivery."
  ].join("\n");
}

export async function askForSessionConsent(
  summary: PolicySummary,
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<boolean> {
  const readline = createInterface({ input, output, terminal: false });
  try {
    output.write(`${renderPolicySummary(summary)}\n`);
    const answer = await readline.question("Start contribution mode? [y/N] ");
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}
