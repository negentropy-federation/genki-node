#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const nativeHome = process.env.HOME;
const temporaryHome = process.env.TMPDIR;

if (!nativeHome || !temporaryHome) {
  process.exit(2);
}

if (args.length === 1 && args[0] === "--version") {
  let version = "agy 1.1.2";
  try {
    version = readFileSync(path.join(nativeHome, "fake-agy-version.txt"), "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (version === "hang") {
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  }
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

const promptIndex = args.indexOf("--print") + 1;
const prompt = promptIndex > 0 ? args[promptIndex] : undefined;
const workspaceIndex = args.indexOf("--add-dir") + 1;
const workspace = workspaceIndex > 0 ? args[workspaceIndex] : undefined;
const logIndex = args.indexOf("--log-file") + 1;
const logPath = logIndex > 0 ? args[logIndex] : undefined;
if (prompt === undefined || workspace === undefined || logPath === undefined) {
  process.exit(2);
}

const safeArgv = args.map((argument, index) => (index === promptIndex ? "[REDACTED]" : argument));
const record = {
  safeArgv,
  promptSha256: createHash("sha256").update(prompt).digest("hex"),
  promptBytes: Buffer.byteLength(prompt),
  pid: process.pid,
  workingDirectory: process.cwd(),
  logPath,
  environment: process.env
};
const recordPath = path.join(temporaryHome, "fake-agy-calls.json");
let records = [];
try {
  records = JSON.parse(readFileSync(recordPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
writeFileSync(recordPath, JSON.stringify([...records, record]), { mode: 0o600 });

let mode = "success";
try {
  mode = readFileSync(path.join(workspace, ".fake-agy-mode"), "utf8").trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

switch (mode) {
  case "success":
    process.exit(0);
    break;
  case "nonzero":
    process.stderr.write("synthetic host failure\n");
    process.exit(9);
    break;
  case "hang":
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
    break;
  default:
    process.exit(2);
}
