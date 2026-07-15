import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { parseSessionPolicy } from "../../core/src/schema.js";
import type { GenkiEngine } from "../../core/src/engine.js";

const safeIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}

export function createGenkiMcpServer(engine: GenkiEngine): McpServer {
  const server = new McpServer({ name: "genki-node", version: "0.1.0" });

  server.registerTool(
    "genki_describe_session",
    {
      description: "Describe a bounded local contribution session before the single consent gate.",
      inputSchema: z
        .object({ taskDirectory: z.string().min(1), policy: z.unknown() })
        .strict()
    },
    async ({ taskDirectory, policy }) =>
      toolResult(
        await engine.describeSession({ taskDirectory, policy: parseSessionPolicy(policy) })
      )
  );

  server.registerTool(
    "genki_activate_session",
    {
      description: "Activate a session after the user has accepted its policy once.",
      inputSchema: z.object({ sessionId: safeIdentifier, policyDigest: digest }).strict()
    },
    async ({ sessionId, policyDigest }) =>
      toolResult(await engine.activateSession(sessionId, policyDigest))
  );

  server.registerTool(
    "genki_prepare_next_task",
    {
      description: "Prepare the next policy-compliant local task for the host agent.",
      inputSchema: z.object({ sessionId: safeIdentifier }).strict()
    },
    async ({ sessionId }) => {
      const prepared = await engine.prepareNextTask(sessionId);
      return toolResult(prepared ?? { done: true });
    }
  );

  server.registerTool(
    "genki_run_validation",
    {
      description: "Run only the validation argv arrays declared by the prepared task.",
      inputSchema: z.object({ runId: safeIdentifier }).strict()
    },
    async ({ runId }) => toolResult(await engine.runValidation(runId))
  );

  server.registerTool(
    "genki_finalize_and_deliver",
    {
      description: "Finalize, automatically deliver, and clean a task without another consent prompt.",
      inputSchema: z.object({ runId: safeIdentifier }).strict()
    },
    async ({ runId }) => toolResult(await engine.finalizeAndDeliver(runId))
  );

  server.registerTool(
    "genki_session_status",
    {
      description: "Return generic contribution counters without task content.",
      inputSchema: z.object({ sessionId: safeIdentifier }).strict(),
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId }) => toolResult(await engine.sessionStatus(sessionId))
  );

  server.registerTool(
    "genki_stop_session",
    {
      description: "Revoke a contribution session and run deterministic local cleanup.",
      inputSchema: z.object({ sessionId: safeIdentifier }).strict(),
      annotations: { destructiveHint: true }
    },
    async ({ sessionId }) => toolResult(await engine.stopSession(sessionId))
  );

  return server;
}
