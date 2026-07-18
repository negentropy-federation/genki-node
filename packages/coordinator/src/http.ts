import { z } from "zod";

import { parseLeasedTask } from "../../core/src/schema.js";
import type { LeasedTask } from "../../core/src/types.js";
import type {
  CheckpointUpload,
  CloseSessionInput,
  CoordinatorClient,
  CoordinatorSession,
  LeaseHeartbeat,
  LeaseStatus,
  OpenSessionInput,
  ResultUpload,
  UploadAck,
  SubmissionStatus,
  StructuredError
} from "./types.js";
import { CoordinatorError } from "./types.js";
import type { PartialCheckpoint } from "../../core/src/types.js";

const uploadAckSchema = z.strictObject({
  operationId: z.string().min(1),
  submissionId: z.string().min(1),
  receiptStatus: z.enum(["received"]),
  verificationStatus: z.enum(["pending", "verified", "rejected"]),
  duplicate: z.boolean()
});

const submissionStatusSchema = z.strictObject({
  submissionId: z.string().min(1),
  receiptStatus: z.enum(["received"]),
  verificationStatus: z.enum(["pending", "verified", "rejected"])
});

const sessionSchema = z.strictObject({
  sessionId: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.string().min(1)
});

const leaseStatusSchema = z.strictObject({
  leaseId: z.string().min(1),
  leaseGeneration: z.number().int().positive(),
  active: z.boolean(),
  expiresAt: z.string().min(1)
});

export interface HttpCoordinatorClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
}

export class HttpCoordinatorError extends Error {
  readonly endpoint: string;
  readonly statusCode: number | null;
  readonly failureCode: string;

  constructor(endpoint: string, statusCode: number | null, failureCode: string) {
    super(`Coordinator ${endpoint} failed (${failureCode}${statusCode === null ? "" : `/${statusCode}`})`);
    this.name = "HttpCoordinatorError";
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    this.failureCode = failureCode;
  }
}

function assertAllowedCoordinatorUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HttpCoordinatorError("config", null, "invalid_url");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && loopback) {
    return parsed;
  }
  throw new HttpCoordinatorError("config", null, "insecure_url");
}

export class HttpCoordinatorClient implements CoordinatorClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxRetries: number;

  constructor(options: HttpCoordinatorClientOptions) {
    this.#baseUrl = assertAllowedCoordinatorUrl(options.baseUrl);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  async openSession(input: OpenSessionInput): Promise<CoordinatorSession> {
    const body = await this.#requestJson({
      endpoint: "open_session",
      method: "POST",
      path: "/v1/contribution-sessions",
      idempotencyKey: crypto.randomUUID(),
      body: input
    });
    return sessionSchema.parse(body);
  }

  async leaseTask(session: CoordinatorSession): Promise<LeasedTask | null> {
    const body = await this.#requestJson({
      endpoint: "lease_task",
      method: "POST",
      path: `/v1/contribution-sessions/${encodeURIComponent(session.sessionId)}/leases`,
      token: session.token,
      idempotencyKey: `lease:${session.sessionId}:${Date.now()}`,
      body: {}
    });
    if (body === null || (typeof body === "object" && body !== null && "task" in body && (body as { task: unknown }).task === null)) {
      return null;
    }
    const taskValue =
      typeof body === "object" && body !== null && "task" in body
        ? (body as { task: unknown }).task
        : body;
    if (taskValue === null) {
      return null;
    }
    return parseLeasedTask(taskValue);
  }

  async heartbeat(input: LeaseHeartbeat): Promise<LeaseStatus> {
    const body = await this.#requestJson({
      endpoint: "heartbeat",
      method: "POST",
      path: `/v1/leases/${encodeURIComponent(input.leaseId)}/heartbeat`,
      token: input.token,
      idempotencyKey: `heartbeat:${input.leaseId}:${input.leaseGeneration}`,
      body: {
        sessionId: input.sessionId,
        leaseGeneration: input.leaseGeneration
      }
    });
    return leaseStatusSchema.parse(body);
  }

  async uploadCheckpoint(input: CheckpointUpload): Promise<UploadAck> {
    const body = await this.#requestJson({
      endpoint: "upload_checkpoint",
      method: "POST",
      path: `/v1/leases/${encodeURIComponent(input.leaseId)}/checkpoints`,
      token: input.token,
      idempotencyKey: input.operationId,
      body: {
        sessionId: input.sessionId,
        leaseGeneration: input.leaseGeneration,
        operationId: input.operationId,
        checkpoint: input.checkpoint
      }
    });
    return uploadAckSchema.parse(body);
  }

  async uploadResult(input: ResultUpload): Promise<UploadAck> {
    const body = await this.#requestJson({
      endpoint: "upload_result",
      method: "POST",
      path: `/v1/leases/${encodeURIComponent(input.leaseId)}/results`,
      token: input.token,
      idempotencyKey: input.operationId,
      body: input
    });
    return uploadAckSchema.parse(body);
  }

  async getSubmission(submissionId: string, session: CoordinatorSession): Promise<SubmissionStatus> {
    const body = await this.#requestJson({
      endpoint: "get_submission",
      method: "GET",
      path: `/v1/submissions/${encodeURIComponent(submissionId)}`,
      token: session.token,
      idempotencyKey: "",
      body: undefined
    });
    return submissionStatusSchema.parse(body);
  }

  async downloadCheckpoint(checkpointId: string, session: CoordinatorSession): Promise<PartialCheckpoint> {
    const body = await this.#requestJson({
      endpoint: "download_checkpoint",
      method: "GET",
      path: `/v1/checkpoints/${encodeURIComponent(checkpointId)}`,
      token: session.token,
      idempotencyKey: "",
      body: undefined
    });
    return body as PartialCheckpoint; // We trust the coordinator's checkpoint payload format
  }

  async closeSession(input: CloseSessionInput): Promise<void> {
    await this.#requestJson({
      endpoint: "close_session",
      method: "POST",
      path: `/v1/contribution-sessions/${encodeURIComponent(input.sessionId)}/close`,
      token: input.token,
      idempotencyKey: `close:${input.sessionId}`,
      body: {}
    });
  }

  async #requestJson(input: {
    endpoint: string;
    method: string;
    path: string;
    body: unknown;
    token?: string;
    idempotencyKey: string;
  }): Promise<unknown> {
    let attempt = 0;
    let lastError: HttpCoordinatorError | null = null;
    while (attempt < this.#maxRetries) {
      attempt += 1;
      try {
        return await this.#once(input);
      } catch (error) {
        if (!(error instanceof HttpCoordinatorError)) {
          throw error;
        }
        lastError = error;
        const retryable =
          error.statusCode === null ||
          error.statusCode === 429 ||
          error.statusCode === 502 ||
          error.statusCode === 503 ||
          error.statusCode === 504;
        if (!retryable || attempt >= this.#maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** (attempt - 1)));
      }
    }
    throw lastError ?? new HttpCoordinatorError(input.endpoint, null, "unknown");
  }

  async #once(input: {
    endpoint: string;
    method: string;
    path: string;
    body: unknown;
    token?: string;
    idempotencyKey: string;
  }): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
      accept: "application/json"
    };
    if (input.token !== undefined) {
      headers.authorization = `Bearer ${input.token}`;
    }

    let response: Response;
    try {
      const fetchInit: RequestInit = {
        method: input.method,
        headers,
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      };
      if (input.body !== undefined) {
        fetchInit.body = JSON.stringify(input.body);
      }
      response = await this.#fetch(new URL(input.path, this.#baseUrl), fetchInit);
    } catch {
      throw new HttpCoordinatorError(input.endpoint, null, "network_error");
    }

    const raw = await response.arrayBuffer();
    if (raw.byteLength > this.#maxResponseBytes) {
      throw new HttpCoordinatorError(input.endpoint, response.status, "response_too_large");
    }
    if (!response.ok) {
      if (raw.byteLength > 0) {
        try {
          const body = JSON.parse(new TextDecoder().decode(raw));
          if (typeof body === "object" && body !== null && "error" in body && "message" in body) {
            throw new CoordinatorError(body as StructuredError, response.status);
          }
        } catch (e) {
          if (e instanceof CoordinatorError) throw e;
        }
      }
      throw new HttpCoordinatorError(input.endpoint, response.status, "http_error");
    }
    if (raw.byteLength === 0) {
      return null;
    }
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      throw new HttpCoordinatorError(input.endpoint, response.status, "invalid_json");
    }
  }
}
