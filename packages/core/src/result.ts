import { writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./storage.js";
import type {
  GenericTaskOutcome,
  PatchSummary,
  ValidationSummary
} from "./types.js";

interface RetainedResultInput {
  runRoot: string;
  outcome: GenericTaskOutcome;
  patch: PatchSummary;
  validation: ValidationSummary;
}

export async function persistRetainedResult(input: RetainedResultInput): Promise<void> {
  await writeJsonAtomic(path.join(input.runRoot, "result.json"), {
    code: input.outcome.code,
    passed: input.outcome.passed,
    patchDigest: input.patch.patchDigest,
    patchBytes: input.patch.patchBytes,
    changedFiles: input.patch.changedFiles
  });
  await writeFile(path.join(input.runRoot, "patch.diff"), input.patch.patch, {
    encoding: "utf8",
    mode: 0o600
  });
  await writeJsonAtomic(path.join(input.runRoot, "validation.json"), input.validation);
}
