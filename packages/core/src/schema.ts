import path from "node:path";

import { z } from "zod";

import type { SessionPolicy, TaskDefinition } from "./types.js";

const MAX_SESSION_SECONDS = 86_400;
const MAX_TASKS = 100;
const MAX_CHANGED_FILES = 100;
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_INSTRUCTION_BYTES = 20_000;

const positiveInteger = z.number().int().positive();
const executableName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._+-]+$/u, "Executable names cannot contain shell syntax");

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
    host: z.literal("agy"),
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
  argv: z.tuple([z.string().min(1)], z.string()),
  timeoutSeconds: positiveInteger.max(MAX_SESSION_SECONDS)
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
