import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { LeasedTask } from "../../packages/core/src/types.js";

export interface FakeCoordinatorServer {
  baseUrl: string;
  close(): Promise<void>;
  requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: unknown }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startFakeCoordinatorServer(task: LeasedTask | null): Promise<FakeCoordinatorServer> {
  const requests: FakeCoordinatorServer["requests"] = [];
  let sessionToken = "";
  let sessionId = "";

  const server: Server = createServer(async (req, res) => {
    const bodyText = await readBody(req);
    const body = bodyText.length === 0 ? null : (JSON.parse(bodyText) as unknown);
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body
    });

    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const idempotency = req.headers["idempotency-key"];
    if (method !== "GET" && (idempotency === undefined || idempotency === "")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing_idempotency_key" }));
      return;
    }

    if (method === "POST" && url === "/v1/contribution-sessions") {
      sessionId = randomUUID();
      sessionToken = randomUUID();
      writeJson(res, 200, {
        sessionId,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 3600_000).toISOString()
      });
      return;
    }

    if (method === "POST" && url === `/v1/contribution-sessions/${sessionId}/leases`) {
      writeJson(res, 200, { task });
      return;
    }

    if (method === "POST" && url.startsWith("/v1/leases/") && url.endsWith("/heartbeat")) {
      const leaseId = url.split("/")[3];
      writeJson(res, 200, {
        leaseId,
        leaseGeneration: 1,
        active: true,
        expiresAt: new Date(Date.now() + 1800_000).toISOString()
      });
      return;
    }

    if (method === "POST" && url.startsWith("/v1/leases/") && url.endsWith("/checkpoints")) {
      writeJson(res, 200, {
        operationId: (body as { operationId?: string })?.operationId ?? "op",
        submissionId: (body as { operationId?: string })?.operationId ?? "op",
        receiptStatus: "received",
        verificationStatus: "pending",
        duplicate: false
      });
      return;
    }

    if (method === "POST" && url.startsWith("/v1/leases/") && url.endsWith("/results")) {
      writeJson(res, 200, {
        operationId: (body as { operationId?: string })?.operationId ?? "op",
        submissionId: (body as { operationId?: string })?.operationId ?? "op",
        receiptStatus: "received",
        verificationStatus: "pending",
        duplicate: false
      });
      return;
    }

    if (method === "POST" && url === `/v1/contribution-sessions/${sessionId}/close`) {
      writeJson(res, 200, {});
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind fake coordinator");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
