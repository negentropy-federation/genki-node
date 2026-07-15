import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { askForSessionConsent, renderPolicySummary } from "./consent.js";

const summary = {
  durationSeconds: 3600,
  maxTasks: 3,
  maxTotalRuntimeSeconds: 1800,
  maxTaskRuntimeSeconds: 600,
  allowedExecutables: ["node"],
  host: "agy" as const,
  model: null,
  retainUntilVerified: false
};

describe("session consent", () => {
  it("renders only the policy envelope", () => {
    const rendered = renderPolicySummary(summary);
    expect(rendered).toContain("1 hour");
    expect(rendered).toContain("3 tasks");
    expect(rendered).toContain("node");
    expect(rendered).toContain("automatically approved");
    expect(rendered).not.toContain("repository");
    expect(rendered).not.toContain("instructions");
    expect(rendered).not.toContain("patch");
  });

  it.each([
    ["y\n", true],
    ["yes\n", true],
    ["n\n", false],
    ["\n", false]
  ])("asks exactly once and maps %j to %s", async (answer, expected) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk: Buffer) => {
      rendered += chunk.toString("utf8");
    });
    input.end(answer);

    await expect(askForSessionConsent(summary, input, output)).resolves.toBe(expected);
    expect(rendered.match(/Start contribution mode/g)).toHaveLength(1);
  });
});
