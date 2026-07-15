import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { parseSessionPolicy } from "../../core/src/schema.js";
import type { GenkiEngine } from "../../core/src/engine.js";

const safeIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);

interface GenkiMcpServerOptions {
  authorizedSessionId?: string;
}

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}

export function createGenkiMcpServer(
  engine: GenkiEngine,
  options: GenkiMcpServerOptions = {}
): McpServer {
  const server = new McpServer({ name: "genki-node", version: "0.1.0" });
  const authorizedRuns = new Set<string>();

  const assertSession = (sessionId: string): void => {
    if (
      options.authorizedSessionId !== undefined &&
      sessionId !== options.authorizedSessionId
    ) {
      throw new Error("This MCP connection is not authorized for that session");
    }
  };

  const assertRun = (runId: string): void => {
    if (options.authorizedSessionId !== undefined && !authorizedRuns.has(runId)) {
      throw new Error("This MCP connection did not prepare that run");
    }
  };

  const assertSessionConfigurationAllowed = (): void => {
    if (options.authorizedSessionId !== undefined) {
      throw new Error("The host MCP connection cannot create or activate sessions");
    }
  };

  server.registerTool(
    "genki_describe_session",
    {
      description: "Describe a bounded local contribution session before the single consent gate.",
      inputSchema: z
        .object({ taskDirectory: z.string().min(1), policy: z.unknown() })
        .strict()
    },
    async ({ taskDirectory, policy }) => {
      assertSessionConfigurationAllowed();
      return toolResult(
        await engine.describeSession({ taskDirectory, policy: parseSessionPolicy(policy) })
      );
    }
  );

  server.registerTool(
    "genki_activate_session",
    {
      description: "Activate a session after the user has accepted its policy once.",
      inputSchema: z.object({ sessionId: safeIdentifier, policyDigest: digest }).strict()
    },
    async ({ sessionId, policyDigest }) => {
      assertSessionConfigurationAllowed();
      return toolResult(await engine.activateSession(sessionId, policyDigest));
    }
  );

  server.registerTool(
    "genki_prepare_next_task",
    {
      description: "Prepare the next policy-compliant local task for the host agent.",
      inputSchema: z.object({ sessionId: safeIdentifier }).strict()
    },
    async ({ sessionId }) => {
      assertSession(sessionId);
      const prepared = await engine.prepareNextTask(sessionId);
      if (prepared !== null) {
        authorizedRuns.add(prepared.runId);
      }
      return toolResult(prepared ?? { done: true });
    }
  );

  server.registerTool(
    "genki_run_validation",
    {
      description: "Run only the validation argv arrays declared by the prepared task.",
      inputSchema: z.object({ runId: safeIdentifier }).strict()
    },
    async ({ runId }) => {
      assertRun(runId);
      return toolResult(await engine.runValidation(runId));
    }
  );

  server.registerTool(
    "genki_finalize_and_deliver",
    {
      description: "Finalize, automatically deliver, and clean a task without another consent prompt.",
      inputSchema: z.object({ runId: safeIdentifier }).strict()
    },
    async ({ runId }) => {
      assertRun(runId);
      const outcome = await engine.finalizeAndDeliver(runId);
      authorizedRuns.delete(runId);
      return toolResult(outcome);
    }
  );

  server.registerTool(
    "genki_session_status",
    {
      description: "Return generic contribution counters without task content.",
      inputSchema: z.object({ sessionId: safeIdentifier }).strict(),
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId }) => {
      assertSession(sessionId);
      return toolResult(await engine.sessionStatus(sessionId));
    }
  );

  server.registerTool(
    "genki_stop_session",
    {
      description: "Revoke a contribution session and run deterministic local cleanup.",
      inputSchema: z.object({ sessionId: safeIdentifier }).strict(),
      annotations: { destructiveHint: true }
    },
    async ({ sessionId }) => {
      assertSession(sessionId);
      const status = await engine.stopSession(sessionId);
      authorizedRuns.clear();
      return toolResult(status);
    }
  );

  return server;
}
