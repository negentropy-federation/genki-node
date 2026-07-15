import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve("plugins/agy");

describe("Agy plugin package", () => {
  it("declares the Genki plugin and local stdio MCP server", async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")) as {
      name?: string;
    };
    const mcp = JSON.parse(await readFile(path.join(pluginRoot, "mcp_config.json"), "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: unknown }>;
    };

    expect(manifest).toEqual({ name: "genki-node" });
    expect(mcp).toEqual({
      mcpServers: { "genki-node": { command: "genki-mcp", args: [] } }
    });
    expect(JSON.stringify(mcp)).not.toMatch(/token|secret|password|\/Users\//iu);
  });

  it("defines a valid contribution skill with all seven tools", async () => {
    const skill = await readFile(
      path.join(pluginRoot, "skills", "genki-contribution", "SKILL.md"),
      "utf8"
    );

    expect(skill).toMatch(/^---\nname: genki-contribution\ndescription:/u);
    for (const tool of [
      "genki_describe_session",
      "genki_activate_session",
      "genki_prepare_next_task",
      "genki_run_validation",
      "genki_finalize_and_deliver",
      "genki_session_status",
      "genki_stop_session"
    ]) {
      expect(skill).toContain(tool);
    }
    expect(skill).toContain("Do not display task content");
    expect(skill).toContain("Do not request per-task consent");
    expect(skill).toContain("Do not request result approval");
    expect(skill).toContain("automatically delivers");
  });
});
