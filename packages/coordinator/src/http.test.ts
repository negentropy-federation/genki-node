import { afterEach, describe, expect, it } from "vitest";

import { startFakeCoordinatorServer } from "../../../tests/fake-coordinator/server.js";
import type { LeasedTask } from "../../core/src/types.js";
import { HttpCoordinatorClient, HttpCoordinatorError } from "./http.js";

const leasedTask: LeasedTask = {
  schemaVersion: "2",
  taskId: "parser-fix",
  revision: 1,
  leaseId: "lease-1",
  leaseGeneration: 1,
  leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  project: {
    projectId: "federation-os",
    repositoryUrl: "https://github.com/negentropy-federation/os-lab.git",
    visibility: "public",
    licenseSpdx: "Apache-2.0",
    baseCommit: "0123456789012345678901234567890123456789"
  },
  goal: "Fix the parser without changing its public API.",
  acceptanceCriteria: ["The parser regression test passes."],
  validation: [{ argv: ["npm", "test"], timeoutSeconds: 300 }],
  policy: {
    maxRuntimeSeconds: 900,
    maxChangedFiles: 5,
    maxPatchBytes: 200_000,
    executionNetwork: "none",
    dependencyDomains: []
  },
  predecessorCheckpoint: null
};

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close();
  }
});

describe("HttpCoordinatorClient", () => {
  it("sends the Federation One lease protocol with idempotency keys", async () => {
    const server = await startFakeCoordinatorServer(leasedTask);
    servers.push(server);
    const client = new HttpCoordinatorClient({ baseUrl: server.baseUrl });

    const session = await client.openSession({
      policyDigest: "a".repeat(64),
      host: "codex",
      contributor: { displayName: null, slogan: null, email: null }
    });
    expect(session.token).toBeTruthy();

    const task = await client.leaseTask(session);
    expect(task?.taskId).toBe("parser-fix");

    const heartbeat = await client.heartbeat({
      sessionId: session.sessionId,
      token: session.token,
      leaseId: "lease-1",
      leaseGeneration: 1
    });
    expect(heartbeat.active).toBe(true);

    const checkpointAck = await client.uploadCheckpoint({
      sessionId: session.sessionId,
      token: session.token,
      leaseId: "lease-1",
      leaseGeneration: 1,
      operationId: "op-checkpoint",
      checkpoint: {
        schemaVersion: "1",
        taskId: "parser-fix",
        taskRevision: 1,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        leaseGeneration: 1,
        baseCommit: leasedTask.project.baseCommit,
        patch: "diff",
        patchDigest: "b".repeat(64),
        changedFiles: ["parser.ts"],
        validation: null,
        host: "codex",
        hostOutcome: "capacity_unavailable",
        completedCriteria: [],
        remainingCriteria: [],
        createdAt: new Date().toISOString()
      }
    });
    expect(checkpointAck.reason).toBe("accepted");

    const resultAck = await client.uploadResult({
      sessionId: session.sessionId,
      token: session.token,
      leaseId: "lease-1",
      leaseGeneration: 1,
      operationId: "op-result",
      taskId: "parser-fix",
      taskRevision: 1,
      attemptId: "attempt-1",
      baseCommit: leasedTask.project.baseCommit,
      patch: "diff",
      patchDigest: "c".repeat(64),
      changedFiles: ["parser.ts"],
      validation: null,
      host: "codex",
      hostOutcome: "completed",
      usage: null,
      completedCriteria: [],
      remainingCriteria: [],
      kind: "result"
    });
    expect(resultAck.reason).toBe("accepted");

    await client.closeSession({ sessionId: session.sessionId, token: session.token });

    const mutating = server.requests.filter((request) => request.method === "POST");
    expect(mutating.length).toBeGreaterThanOrEqual(6);
    for (const request of mutating) {
      expect(request.headers["idempotency-key"]).toBeTruthy();
    }
    const authorized = mutating.filter((request) => request.url.includes("/leases"));
    for (const request of authorized) {
      expect(request.headers.authorization).toBe(`Bearer ${session.token}`);
    }
    expect(JSON.stringify(server.requests)).not.toContain("Authorization");
  });

  it("rejects non-HTTPS coordinator URLs outside loopback", () => {
    expect(() => new HttpCoordinatorClient({ baseUrl: "http://example.com" })).toThrow(
      HttpCoordinatorError
    );
    expect(() => new HttpCoordinatorClient({ baseUrl: "https://example.com" })).not.toThrow();
  });
});
