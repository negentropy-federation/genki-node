import path from "node:path";

import validator from "validator";
import { z } from "zod";

import { ACCEPTED_SPDX_LICENSES } from "./types.js";
import type {
  LeasedTask,
  PartialCheckpoint,
  SessionPolicy,
  TaskDefinition
} from "./types.js";

const MAX_SESSION_SECONDS = 86_400;
const MAX_TASKS = 100;
const MAX_CHANGED_FILES = 100;
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_INSTRUCTION_BYTES = 20_000;

const positiveInteger = z.number().int().positive();
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeIdentifier = z.string().regex(/^[A-Za-z0-9._-]+$/u);
const gitCommit = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const hostNameSchema = z.enum(["agy", "codex"]);
const hostOutcomeCodeSchema = z.enum([
  "completed",
  "quota_exhausted",
  "capacity_unavailable",
  "authentication_failed",
  "host_failed",
  "interrupted",
  "timed_out"
]);
const executableName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._+-]+$/u, "Executable names cannot contain shell syntax");
const repositoryUrl = z
  .string()
  .refine(
    (value) =>
      value.startsWith("https://") &&
      validator.isURL(value, {
        protocols: ["https"],
        require_protocol: true,
        require_valid_protocol: true,
        require_host: true,
        require_tld: true,
        allow_protocol_relative_urls: false,
        allow_fragments: false,
        allow_query_components: false,
        disallow_auth: true,
        allow_underscores: false
      }),
    "Repository URL must use HTTPS without userinfo, query, or fragment"
  );

const sessionPolicySchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    durationSeconds: positiveInteger.max(MAX_SESSION_SECONDS),
    maxTasks: positiveInteger.max(MAX_TASKS),
    maxTotalRuntimeSeconds: positiveInteger.max(MAX_SESSION_SECONDS),
    maxTaskRuntimeSeconds: positiveInteger.max(MAX_SESSION_SECONDS),
    maxChangedFiles: positiveInteger.max(MAX_CHANGED_FILES),
    maxPatchBytes: positiveInteger.max(MAX_PATCH_BYTES),
    allowedExecutables: z.array(executableName).min(1).max(32),
    host: hostNameSchema,
    model: z.string().min(1).max(200).nullable(),
    retainUntilVerified: z.boolean()
  })
  .superRefine((policy, context) => {
    if (policy.maxTaskRuntimeSeconds > policy.maxTotalRuntimeSeconds) {
      context.addIssue({
        code: "custom",
        message: "Per-task runtime cannot exceed total session runtime",
        path: ["maxTaskRuntimeSeconds"]
      });
    }
  });

const validationCommandSchema = z.strictObject({
  argv: z.tuple([executableName], z.string()),
  timeoutSeconds: positiveInteger.max(MAX_SESSION_SECONDS)
});

const checkpointReferenceSchema = z.strictObject({
  checkpointId: safeIdentifier,
  baseCommit: gitCommit,
  patchDigest: sha256Digest
});

const leasedTaskSchema = z
  .strictObject({
    schemaVersion: z.literal("2"),
    taskId: safeIdentifier,
    revision: positiveInteger,
    leaseId: safeIdentifier,
    leaseGeneration: positiveInteger,
    leaseExpiresAt: z.iso.datetime(),
    project: z.strictObject({
      projectId: safeIdentifier,
      repositoryUrl,
      visibility: z.literal("public"),
      licenseSpdx: z.enum(ACCEPTED_SPDX_LICENSES),
      baseCommit: gitCommit
    }),
    goal: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_INSTRUCTION_BYTES,
        `Goal cannot exceed ${MAX_INSTRUCTION_BYTES} bytes`
      ),
    acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(100),
    validation: z.array(validationCommandSchema).min(1).max(16),
    policy: z.strictObject({
      maxRuntimeSeconds: positiveInteger.max(MAX_SESSION_SECONDS),
      maxChangedFiles: positiveInteger.max(MAX_CHANGED_FILES),
      maxPatchBytes: positiveInteger.max(MAX_PATCH_BYTES),
      executionNetwork: z.literal("none"),
      dependencyDomains: z.array(z.string().min(1).max(253)).max(32)
    }),
    predecessorCheckpoint: checkpointReferenceSchema.nullable()
  })
  .superRefine((task, context) => {
    if (Date.parse(task.leaseExpiresAt) <= Date.now()) {
      context.addIssue({
        code: "custom",
        message: "Task lease has expired",
        path: ["leaseExpiresAt"]
      });
    }
  });

const boundedValidationCommandSummarySchema = z.strictObject({
  executable: executableName,
  exitCode: z.number().int().min(0).max(255).nullable(),
  timedOut: z.boolean(),
  durationMs: nonnegativeSafeInteger
});

const boundedValidationSummarySchema = z.strictObject({
  passed: z.boolean(),
  commands: z.array(boundedValidationCommandSummarySchema).max(16),
  durationMs: nonnegativeSafeInteger
});

const partialCheckpointSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  taskId: safeIdentifier,
  taskRevision: positiveInteger,
  attemptId: safeIdentifier,
  leaseId: safeIdentifier,
  leaseGeneration: positiveInteger,
  baseCommit: gitCommit,
  patch: z
    .string()
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_PATCH_BYTES,
      `Patch cannot exceed ${MAX_PATCH_BYTES} bytes`
    ),
  patchDigest: sha256Digest,
  changedFiles: z.array(z.string().min(1)).max(MAX_CHANGED_FILES),
  validation: boundedValidationSummarySchema.nullable(),
  host: hostNameSchema,
  hostOutcome: hostOutcomeCodeSchema,
  completedCriteria: z.array(z.string().min(1).max(1_000)).max(100),
  remainingCriteria: z.array(z.string().min(1).max(1_000)).max(100),
  createdAt: z.iso.datetime()
});

const taskDefinitionSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/u),
  title: z.string().min(1).max(200),
  repository: z.strictObject({
    path: z.string().min(1).refine((value) => path.isAbsolute(value), "Repository path must be absolute"),
    baseRef: z.string().min(1).max(200)
  }),
  instructions: z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_INSTRUCTION_BYTES,
      `Instructions cannot exceed ${MAX_INSTRUCTION_BYTES} bytes`
    ),
  validation: z.array(validationCommandSchema).min(1).max(16),
  policy: z.strictObject({
    maxRuntimeSeconds: positiveInteger.max(MAX_SESSION_SECONDS),
    maxChangedFiles: positiveInteger.max(MAX_CHANGED_FILES),
    maxPatchBytes: positiveInteger.max(MAX_PATCH_BYTES)
  })
});

export function parseSessionPolicy(input: unknown): SessionPolicy {
  return sessionPolicySchema.parse(input);
}

export function parseTaskDefinition(input: unknown): TaskDefinition {
  return taskDefinitionSchema.parse(input);
}

export function parseLeasedTask(input: unknown): LeasedTask {
  return leasedTaskSchema.parse(input);
}

export function parsePartialCheckpoint(input: unknown): PartialCheckpoint {
  return partialCheckpointSchema.parse(input);
}
