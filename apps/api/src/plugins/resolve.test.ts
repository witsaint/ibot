/**
 * Capability resolution: which plugins are live for a bot, which of its skills the model may see, and
 * how same-named skills collapse. These are the rules the run loop depends on, so they're tested
 * against the pure functions plus a minimal db stub — no live Postgres.
 */
import type { Database } from "@i-bot/db";
import type { PluginManifest } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import { normalizeManifest } from "./manifest.js";
import {
  composePluginNotes,
  CORE_PLUGIN_KEY,
  dedupeSkillsByPrecedence,
  type ResolvedPlugin,
  type ResolvedPlugins,
  resolvePluginsForBot,
  visibleSkills,
} from "./resolve.js";
import { RENDER_CARD_TOOL } from "./ui-templates.js";

const BOT = "bot-1";
const OWNER = "user-1";

/**
 * Build a manifest from a partial declaration. The param is the INPUT shape (pre-defaults), not
 * `Partial<PluginManifest>` — that's the parsed output, where every array and flag is already
 * required, so a literal like `{name, description, playbook}` wouldn't typecheck against it.
 */
function manifest(partial: { key: string } & Record<string, unknown>): PluginManifest {
  return normalizeManifest(
    {
      version: "1.0.0",
      displayName: partial.key,
      description: "",
      ...partial,
    },
    { source: partial.key === CORE_PLUGIN_KEY ? "builtin" : "installed" },
  );
}

/**
 * A db stub answering only the three reads `resolvePluginsForBot` performs: the bot's owner, the
 * owner's installs, and the plugin rows those point at.
 */
function stubDb(input: {
  ownerId?: string | null;
  rows: {
    key: string;
    source?: "builtin" | "installed" | "local";
    enabled?: boolean;
    enabledBots?: string[] | null;
    manifest?: PluginManifest;
  }[];
}): Database {
  const plugins = input.rows.map((r, i) => ({
    id: `plugin-${i}`,
    key: r.key,
    version: "1.0.0",
    source: r.source ?? "installed",
    displayName: r.key,
    description: "",
    manifest: r.manifest ?? manifest({ key: r.key }),
    contentHash: `hash-${i}`,
  }));
  const installs = plugins.map((p, i) => ({
    id: `install-${i}`,
    pluginId: p.id,
    ownerType: "user" as const,
    ownerId: OWNER,
    enabled: input.rows[i]!.enabled ?? true,
    enabledBots: input.rows[i]!.enabledBots ?? null,
    config: {},
  }));
  return {
    query: {
      bots: {
        findFirst: async () =>
          input.ownerId === null ? undefined : { ownerId: input.ownerId ?? OWNER },
      },
      pluginInstalls: { findMany: async () => installs },
      plugins: { findMany: async () => plugins },
    },
  } as unknown as Database;
}

describe("resolvePluginsForBot", () => {
  it("returns an empty set for a bot with no owner instead of throwing", async () => {
    const out = await resolvePluginsForBot(stubDb({ ownerId: null, rows: [] }), BOT);
    expect(out.plugins).toEqual([]);
    expect(out.toolNames.size).toBe(0);
  });

  it("drops a disabled install", async () => {
    const out = await resolvePluginsForBot(
      stubDb({ rows: [{ key: "@acme/a" }, { key: "@acme/b", enabled: false }] }),
      BOT,
    );
    expect(out.plugins.map((p) => p.key)).toEqual(["@acme/a"]);
  });

  it("keeps core live even when its install says disabled", async () => {
    const out = await resolvePluginsForBot(
      stubDb({ rows: [{ key: CORE_PLUGIN_KEY, source: "builtin", enabled: false }] }),
      BOT,
    );
    expect(out.plugins.map((p) => p.key)).toEqual([CORE_PLUGIN_KEY]);
  });

  it("honours an enabledBots allowlist, and treats null as every bot", async () => {
    const out = await resolvePluginsForBot(
      stubDb({
        rows: [
          { key: "@acme/all", enabledBots: null },
          { key: "@acme/mine", enabledBots: [BOT] },
          { key: "@acme/theirs", enabledBots: ["bot-2"] },
        ],
      }),
      BOT,
    );
    expect(out.plugins.map((p) => p.key)).toEqual(["@acme/all", "@acme/mine"]);
  });

  it("orders builtin → installed → local so the closest-to-user wins a collision", async () => {
    const out = await resolvePluginsForBot(
      stubDb({
        rows: [
          { key: "local:bot-1", source: "local" },
          { key: "@acme/z", source: "installed" },
          { key: "@ibot/ui", source: "builtin" },
        ],
      }),
      BOT,
    );
    expect(out.plugins.map((p) => p.source)).toEqual(["builtin", "installed", "local"]);
  });

  it("namespaces an agent by plugin key, and reaches every card through the one card tool", async () => {
    const out = await resolvePluginsForBot(
      stubDb({
        rows: [
          {
            key: "@ibot/ui",
            source: "builtin",
            manifest: manifest({
              key: "@ibot/ui",
              ui: [
                { name: "render_choice", description: "d", input: {}, template: [] },
                { name: "render_form", description: "d", input: {}, template: [] },
              ],
              agents: [{ name: "helper", description: "d", prompt: "p" }],
            }),
          },
        ],
      }),
      BOT,
    );
    // Two templates, ONE tool name: templates are data passed to `render_card`, so the model's tool
    // list doesn't grow with what's installed. Agents are still a tool each.
    expect([...out.toolNames].sort()).toEqual(["agent__ibot_ui__helper", RENDER_CARD_TOOL]);
  });

  it("only trusts a builtin's providedTools (an imported row can't widen an allowlist)", async () => {
    const claim = manifest({ key: "@acme/liar" });
    // Bypass the importer's strip to simulate a hand-written / tampered row.
    claim.providedTools = [{ name: "run_command", description: "" }];
    const out = await resolvePluginsForBot(
      stubDb({ rows: [{ key: "@acme/liar", source: "installed", manifest: claim }] }),
      BOT,
    );
    expect(out.providedToolNames.size).toBe(0);
  });
});

/** Build a resolution directly, for the pure skill-filter functions. */
function resolution(plugins: Partial<ResolvedPlugin>[]): ResolvedPlugins {
  const full = plugins.map((p, i) => ({
    pluginId: p.pluginId ?? `plugin-${i}`,
    installId: `install-${i}`,
    key: p.key ?? `@acme/${i}`,
    version: "1.0.0",
    source: p.source ?? ("installed" as const),
    displayName: p.displayName ?? p.key ?? `@acme/${i}`,
    description: "",
    manifest: p.manifest ?? manifest({ key: p.key ?? `@acme/${i}` }),
    config: {},
  }));
  return {
    plugins: full,
    byKey: new Map(full.map((p) => [p.key, p])),
    toolNames: new Set(),
    providedToolNames: new Set(),
  };
}

describe("visibleSkills", () => {
  it("keeps a row with no plugin (nothing owns it, so nothing can hide it)", () => {
    const rows = [{ name: "Ad hoc", pluginId: null }];
    expect(visibleSkills(rows, resolution([]))).toEqual(rows);
  });

  it("drops a row whose plugin declares it hidden", () => {
    const m = manifest({
      key: "@acme/a",
      skills: [
        { name: "Internal", description: "d", playbook: "p", hidden: true },
        { name: "Public", description: "d", playbook: "p" },
      ],
    });
    const resolved = resolution([{ pluginId: "p1", key: "@acme/a", manifest: m }]);
    const rows = [
      { name: "Internal", pluginId: "p1" },
      { name: "Public", pluginId: "p1" },
    ];
    expect(visibleSkills(rows, resolved).map((r) => r.name)).toEqual(["Public"]);
  });

  it("drops a row whose plugin is no longer live, even if the row outlived the disable", () => {
    const resolved = resolution([{ pluginId: "p1" }]);
    const rows = [
      { name: "Live", pluginId: "p1" },
      { name: "Orphan", pluginId: "gone" },
    ];
    expect(visibleSkills(rows, resolved).map((r) => r.name)).toEqual(["Live"]);
  });
});

describe("dedupeSkillsByPrecedence", () => {
  it("keeps the local copy when a builtin and a local declare the same name", () => {
    const resolved = resolution([
      { pluginId: "builtin-1", source: "builtin" },
      { pluginId: "local-1", source: "local" },
    ]);
    const rows = [
      { name: "Deploy", pluginId: "builtin-1", body: "shipped" },
      { name: "Deploy", pluginId: "local-1", body: "mine" },
    ];
    const out = dedupeSkillsByPrecedence(rows, resolved);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("mine");
  });

  it("lets a row with no plugin outrank every plugin's copy", () => {
    const resolved = resolution([{ pluginId: "local-1", source: "local" }]);
    const rows = [
      { name: "Deploy", pluginId: "local-1", body: "plugin" },
      { name: "deploy", pluginId: null, body: "hand-written" },
    ];
    const out = dedupeSkillsByPrecedence(rows, resolved);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("hand-written");
  });

  it("leaves distinct names alone", () => {
    const resolved = resolution([{ pluginId: "p1" }]);
    const rows = [
      { name: "A", pluginId: "p1" },
      { name: "B", pluginId: "p1" },
    ];
    expect(dedupeSkillsByPrecedence(rows, resolved)).toHaveLength(2);
  });
});

describe("composePluginNotes", () => {
  it("says nothing when no plugin contributes anything nameable (core alone)", () => {
    const resolved = resolution([
      { key: CORE_PLUGIN_KEY, source: "builtin", manifest: manifest({ key: CORE_PLUGIN_KEY }) },
    ]);
    expect(composePluginNotes(resolved)).toBe("");
  });

  it("lists each plugin's contributions by the names the model would use", () => {
    const m = manifest({
      key: "@ibot/ui",
      ui: [{ name: "render_choice", description: "d", input: {}, template: [] }],
      skills: [{ name: "When to use a card", description: "d", playbook: "p" }],
    });
    const resolved = resolution([
      { key: "@ibot/ui", source: "builtin", displayName: "卡片", manifest: m },
    ]);
    const notes = composePluginNotes(resolved);
    expect(notes).toContain("## Installed plugins");
    expect(notes).toContain("卡片");
    // The template ID, not a tool name — `render_card`'s own description carries the inputs.
    expect(notes).toContain("ibot_ui.render_choice");
    expect(notes).toContain("When to use a card");
  });

  it("omits a hidden skill from the notes", () => {
    const m = manifest({
      key: "@acme/a",
      skills: [{ name: "Internal", description: "d", playbook: "p", hidden: true }],
    });
    const resolved = resolution([{ key: "@acme/a", manifest: m }]);
    expect(composePluginNotes(resolved)).toBe("");
  });
});
