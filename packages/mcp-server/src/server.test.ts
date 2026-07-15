import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenkiEngine } from "../../core/src/engine.js";
import { createGenkiMcpServer } from "./server.js";

const privateTask = {
  runId: "run-1",
  workspace: "/private/genki/workspace",
  instructions: "Private task instructions"
};

function fakeEngine(): GenkiEngine {
  return {
    describeSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      policyDigest: "digest",
      sessionRoot: "/private/genki/session",
      agyLogPath: "/private/genki/session/agy.log",
      summary: {
        durationSeconds: 3600,
        maxTasks: 2,
        maxTotalRuntimeSeconds: 1800,
        maxTaskRuntimeSeconds: 900,
        allowedExecutables: ["node"],
        host: "agy",
        model: null,
        retainUntilVerified: false
      }
    }),
    activateSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      state: "active",
      completed: 0,
      failed: 0,
      remaining: 1,
      elapsedSeconds: 0,
      remainingRuntimeSeconds: 1800,
      lastOutcomeCode: null
    }),
    prepareNextTask: vi.fn().mockResolvedValue(privateTask),
    runValidation: vi.fn().mockResolvedValue({ passed: true, commands: [], durationMs: 1 }),
    finalizeAndDeliver: vi.fn().mockResolvedValue({ code: "DELIVERED", passed: true }),
    sessionStatus: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      state: "active",
      completed: 1,
      failed: 0,
      remaining: 0,
      elapsedSeconds: 3,
      remainingRuntimeSeconds: 1799,
      lastOutcomeCode: "DELIVERED"
    }),
    stopSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      state: "revoked",
      completed: 1,
      failed: 0,
      remaining: 0,
      elapsedSeconds: 4,
      remainingRuntimeSeconds: 1799,
      lastOutcomeCode: "DELIVERED"
    })
  } as unknown as GenkiEngine;
}

describe("Genki MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(async (close) => close()));
  });

  async function connect() {
    const server = createGenkiMcpServer(fakeEngine());
    const client = new Client({ name: "genki-test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("lists exactly the seven host-neutral tools", async () => {
    const client = await connect();
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "genki_activate_session",
        "genki_describe_session",
        "genki_finalize_and_deliver",
        "genki_prepare_next_task",
        "genki_run_validation",
        "genki_session_status",
        "genki_stop_session"
      ].sort()
    );
  });

  it("returns generic status without private task data", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "genki_session_status",
      arguments: { sessionId: "session-1" }
    });

    expect(result.structuredContent).toMatchObject({ completed: 1, lastOutcomeCode: "DELIVERED" });
    expect(JSON.stringify(result)).not.toContain("Private task");
    expect(JSON.stringify(result)).not.toContain("/private/genki/workspace");
  });

  it("returns task content only from prepare-next-task", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "genki_prepare_next_task",
      arguments: { sessionId: "session-1" }
    });

    expect(result.structuredContent).toEqual(privateTask);
  });

  it("rejects malformed tool input at the protocol boundary", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "genki_session_status",
      arguments: { sessionId: "bad id with spaces" }
    });

    expect(result.isError).toBe(true);
  });
});
