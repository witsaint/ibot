import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skillCommandFromParts } from "@i-bot/types";
import { importPluginDirectory, inspectManifest } from "./import-dir.js";
import { normalizeManifest } from "./manifest.js";
import {
  callableSkills,
  commandSkill,
  composePluginNotes,
  visibleSkills,
  type ResolvedPlugin,
  type ResolvedPlugins,
} from "./resolve.js";

function plugin(key: string, hidden = false): ResolvedPlugin {
  return {
    pluginId: key,
    installId: key,
    key,
    source: "installed",
    version: "1.0.0",
    displayName: key,
    description: "",
    config: {},
    manifest: normalizeManifest(
      {
        key,
        version: "1.0.0",
        displayName: key,
        description: "",
        skills: [
          { name: "网页创作", description: "", playbook: "manual secret", command: "web", hidden },
          { name: "普通技能", description: "", playbook: "automatic" },
        ],
      },
      { source: "installed" },
    ),
  };
}
function resolved(...plugins: ResolvedPlugin[]): ResolvedPlugins {
  return {
    plugins,
    byKey: new Map(plugins.map((p) => [p.key, p])),
    toolNames: new Set(),
    providedToolNames: new Set(),
  };
}
const rows = [
  { name: "网页创作", pluginId: "a" },
  { name: "普通技能", pluginId: "a" },
  { name: "自己的技能", pluginId: null },
];

describe("explicit plugin invocation", () => {
  it("recognizes only a command prefix in the first text part", () => {
    expect(skillCommandFromParts([{ type: "text", text: " /web 帮我做网页" }])).toBe("web");
    for (const text of [
      "讨论 /web 怎么用",
      "```\n/web example\n```",
      "/webpageX 内容",
      "> /web 引用",
      "https://site/web",
    ]) {
      expect(skillCommandFromParts([{ type: "text", text }])).toBeUndefined();
    }
    expect(
      skillCommandFromParts([
        { type: "text", text: "资料" },
        { type: "text", text: "/web" },
      ]),
    ).toBeUndefined();
    expect(skillCommandFromParts([{ type: "data-uiEvent", text: "/web" }])).toBeUndefined();
  });
  it("excludes manual instructions and plugin notes from ordinary turns", () => {
    const out = resolved(plugin("a"));
    expect(visibleSkills(rows, out).map((s) => s.name)).toEqual(["普通技能", "自己的技能"]);
    expect(composePluginNotes(out)).not.toContain("网页创作");
    expect(callableSkills(rows, out)[0]?.command).toBe("web");
    expect(visibleSkills(rows, out, "web").map((s) => s.name)).toContain("网页创作");
    expect(composePluginNotes(out, "web")).toContain("网页创作");
    expect(visibleSkills(rows, out, "another").map((s) => s.name)).not.toContain("网页创作");
  });
  it("disabled and hidden plugins cannot be invoked or offered", () => {
    for (const out of [resolved(), resolved(plugin("a", true))]) {
      expect(commandSkill(out, "web")).toBeUndefined();
      expect(visibleSkills(rows, out, "web").map((s) => s.name)).not.toContain("网页创作");
      expect(callableSkills(rows, out).some((s) => s.command === "web")).toBe(false);
    }
  });
  it("resolves a command collision to one plugin by precedence", () => {
    const out = resolved(plugin("a"), plugin("b"));
    const both = [...rows, { name: "网页创作", pluginId: "b" }];
    expect(commandSkill(out, "web")?.pluginId).toBe("b");
    expect(visibleSkills(both, out, "web").filter((s) => s.name === "网页创作")).toEqual([
      { name: "网页创作", pluginId: "b", command: "web" },
    ]);
  });
  it("rejects duplicate commands within one package", () => {
    expect(() =>
      normalizeManifest(
        {
          ...plugin("a").manifest,
          skills: [
            plugin("a").manifest.skills[0],
            { name: "第二个入口", description: "", playbook: "", command: "web" },
          ],
        },
        { source: "installed" },
      ),
    ).toThrow("duplicate");
  });
  it("imports the real package as one manual entry with lazy reference files", async () => {
    const manifest = await importPluginDirectory(
      fileURLToPath(new URL("../../../../plugins/web-creator", import.meta.url)),
    );
    expect(manifest.key).toBe("@ibot/web-creator");
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0]?.command).toBe("web");
    expect(manifest.skills[0]?.hidden).toBe(false);
    expect(manifest.skills[0]?.files.map((f) => f.path).sort()).toEqual([
      "references/content.md",
      "references/design-template.md",
      "references/design.md",
      "references/development.md",
      "references/directions.md",
      "references/images.md",
      "references/resources.md",
      "references/review.md",
      "references/workflow.md",
    ]);
    expect(manifest.setupSteps).toHaveLength(0);
    expect(manifest.mcpServers).toHaveLength(0);
    expect(inspectManifest(manifest).skills[0]?.command).toBe("web");
  });
});
