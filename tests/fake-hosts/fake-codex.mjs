#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME;

process.on("SIGTERM", () => process.exit(143));

if (!home) {
  process.exit(2);
}

if (args.length === 1 && args[0] === "--version") {
  let version = "codex-cli 0.144.2";
  try {
    version = readFileSync(path.join(home, "fake-codex-version.txt"), "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (version === "hang-ignore-term") {
    process.removeAllListeners("SIGTERM");
    process.on("SIGTERM", () => undefined);
    setTimeout(() => process.exit(124), 300);
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  } else {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }
}

const workspaceIndex = args.indexOf("-C");
const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
if (!workspace) {
  process.exit(2);
}

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  stdin += chunk;
}

const record = {
  argv: args,
  stdinSha256: createHash("sha256").update(stdin).digest("hex"),
  stdinBytes: Buffer.byteLength(stdin),
  pid: process.pid,
  environment: process.env
};
const recordPath = path.join(home, "fake-codex-calls.json");
let records = [];
try {
  records = JSON.parse(readFileSync(recordPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
writeFileSync(recordPath, JSON.stringify([...records, record]), {
  mode: 0o600
});

let mode = "success";
try {
  mode = readFileSync(path.join(workspace, ".fake-codex-mode"), "utf8").trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const events = [
  { type: "thread.started", thread_id: "thread-local-only" },
  { type: "turn.started" }
];

const writeEvents = (additionalEvents) => {
  for (const event of [...events, ...additionalEvents]) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
};

const finalItem = (value) => ({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify(value)
  }
});

const usage = {
  type: "turn.completed",
  usage: {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 30,
    reasoning_output_tokens: 10
  }
};

switch (mode) {
  case "success":
    writeEvents([
      { type: "item.completed", item: { type: "command_execution", text: "ignored" } },
      { type: "future.event", payload: { ignored: true } },
      finalItem({
        completedCriteria: ["criterion complete"],
        remainingCriteria: ["criterion remaining"]
      }),
      usage
    ]);
    break;
  case "success-with-diagnostic-words":
    writeEvents([
      finalItem({
        completedCriteria: ["Documented codex login behavior"],
        remainingCriteria: ["Capacity planning", "Capacity review"]
      }),
      usage
    ]);
    break;
  case "quota":
    writeEvents([
      {
        type: "error",
        message: "Usage limit exhausted for this account",
        codex_error_info: "usage_limit_exceeded"
      }
    ]);
    process.exitCode = 1;
    break;
  case "quota-malformed":
    process.stdout.write(
      `${JSON.stringify({
        type: "error",
        message: "Usage limit exhausted for this account",
        codex_error_info: "usage_limit_exceeded"
      })}\n{not-json}\n`
    );
    process.exitCode = 1;
    break;
  case "bare-quota":
    writeEvents([]);
    process.stderr.write("Quota information is unavailable\n");
    process.exitCode = 1;
    break;
  case "usage-metadata-failed":
    writeEvents([]);
    process.stderr.write("Failed to fetch usage limit metadata\n");
    process.exitCode = 1;
    break;
  case "credits-exhausted":
    writeEvents([]);
    process.stderr.write("Credits exhausted for this account\n");
    process.exitCode = 1;
    break;
  case "quota-code-exhausted":
    writeEvents([{ type: "error", codex_error_info: "quota_exhausted" }]);
    process.exitCode = 1;
    break;
  case "usage-limit-exceeded-code":
    writeEvents([{ type: "error", codex_error_info: "usage_limit_exceeded" }]);
    process.exitCode = 1;
    break;
  case "insufficient-quota-code":
    writeEvents([{ type: "error", code: "insufficient_quota" }]);
    process.exitCode = 1;
    break;
  case "quota-exceeded-code":
    writeEvents([{ type: "turn.failed", error: { code: "quota_exceeded" } }]);
    process.exitCode = 1;
    break;
  case "hit-usage-limit":
    writeEvents([]);
    process.stderr.write("You have hit your usage limit\n");
    process.exitCode = 1;
    break;
  case "authentication":
    writeEvents([]);
    process.stderr.write("Authentication failed; please run codex login\n");
    process.exitCode = 1;
    break;
  case "authentication-incidental-login":
    writeEvents([]);
    process.stderr.write("Codex login documentation was refreshed\n");
    process.exitCode = 1;
    break;
  case "capacity-once":
    writeEvents([]);
    process.stderr.write("Service temporarily unavailable\n");
    process.exitCode = 1;
    break;
  case "capacity-repeated":
    writeEvents([]);
    process.stderr.write("Service temporarily unavailable\nService temporarily unavailable\n");
    process.exitCode = 1;
    break;
  case "capacity-distinct-events":
    writeEvents([
      { type: "error", message: "Service temporarily unavailable" },
      { type: "turn.failed", error: { message: "Try again later" } }
    ]);
    process.exitCode = 1;
    break;
  case "capacity-phrases-one-record":
    writeEvents([]);
    process.stderr.write("Service temporarily unavailable; overloaded; try again later\n");
    process.exitCode = 1;
    break;
  case "malformed":
    process.stdout.write(`${JSON.stringify(events[0])}\n{not-json}\n`);
    process.exitCode = 1;
    break;
  case "missing-final":
    writeEvents([usage]);
    break;
  case "missing-turn":
    writeEvents([
      finalItem({ completedCriteria: [], remainingCriteria: ["not done"] })
    ]);
    break;
  case "invalid-usage":
    writeEvents([
      finalItem({ completedCriteria: [], remainingCriteria: [] }),
      {
        type: "turn.completed",
        usage: {
          input_tokens: -1,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0
        }
      }
    ]);
    break;
  case "invalid-criteria":
    writeEvents([
      finalItem({ completedCriteria: ["x".repeat(501)], remainingCriteria: [] }),
      usage
    ]);
    break;
  case "host-failed":
    writeEvents([]);
    process.stderr.write("Ordinary host failure\n");
    process.exitCode = 9;
    break;
  case "hang":
    setInterval(() => undefined, 1_000);
    break;
  default:
    process.exit(2);
}
