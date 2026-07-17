import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("README", () => {
  it("documents installation, operation, cleanup, and privacy boundaries", async () => {
    const readme = await readFile("README.md", "utf8");

    for (const requiredText of [
      "npm run check",
      "npm install -g .",
      "agy plugin validate",
      "agy plugin install",
      "genki contribute",
      "genki stop",
      "genki cleanup",
      "hidden by default",
      "Agy-owned records",
      "--host agy",
      "--host codex",
      "--coordinator",
      "outer-sandbox",
      "experimental"
    ]) {
      expect(readme).toContain(requiredText);
    }

    expect(readme).not.toMatch(/pool personal.*(ChatGPT|Claude|Copilot)/iu);
    expect(readme).not.toMatch(/arbitrary remote private repositories are supported/iu);
  });
});
