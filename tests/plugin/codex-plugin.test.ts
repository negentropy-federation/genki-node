import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve("plugins/codex/genki-node");

describe("Codex plugin package", () => {
  it("declares a genki-node manifest and contribution skill", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
    ) as { name?: string };
    const skill = await readFile(
      path.join(pluginRoot, "skills", "genki-contribution", "SKILL.md"),
      "utf8"
    );

    expect(manifest.name).toBe("genki-node");
    expect(skill).toMatch(/one session consent/i);
    expect(skill).toMatch(/automatic patch and checkpoint upload/i);
    expect(skill).not.toMatch(/we support production plan pooling/iu);
    expect(skill).not.toMatch(/arbitrary private repositories are enabled/iu);
  });
});
