#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { GenkiEngine } from "../../core/src/engine.js";
import { createGenkiMcpServer } from "./server.js";

async function main(): Promise<void> {
  const stateRoot =
    process.env.GENKI_STATE_ROOT ?? path.join(os.homedir(), ".local", "state", "genki-node");
  const server = createGenkiMcpServer(new GenkiEngine({ stateRoot }));
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`genki-mcp: ${message}\n`);
  process.exitCode = 1;
});
