/**
 * The card-template layer: the expander's substitution rules, the input guard, the catalog, and —
 * the part that matters most — that each of the three SHIPPED templates expands into a panel the
 * client would actually render.
 *
 * That last group is the real safety net. A template is data, so a typo in it (a wrong variant, a
 * child id that doesn't exist, a prop the strict catalog schema rejects) can't be caught by
 * TypeScript; it would surface as a card stuck at `[Loading root...]` in front of a user. Expanding
 * each one against realistic input and running the SAME `validateA2uiMessages` the render path uses
 * turns that into a test failure here.
 */
import type { PluginManifest } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import { validateA2uiMessages } from "../agent/a2ui-validate.js";
import { BUILTIN_MANIFESTS } from "./builtin.js";
import type { ResolvedPlugin, ResolvedPlugins } from "./resolve.js";
import {
  buildRenderCardTool,
  checkTemplateInput,
  collectUiTemplates,
  expandTemplate,
  RENDER_CARD_TOOL,
  templateId,
  type UiTemplate,
} from "./ui-templates.js";

/**
 * Expand with a fixed surface id so assertions can name it. Returns plain records: the expander's
 * declared output is `A2uiMessage[]`, but these unit cases feed it fragments rather than whole
 * messages, so the message shape would only get in the way of the assertion.
 */
function expand(template: unknown[], input: Record<string, unknown>): Record<string, unknown>[] {
  return expandTemplate(template as never, { input, surfaceId: "s1" }) as unknown as Record<
    string,
    unknown
  >[];
}

describe("expandTemplate: substitution", () => {
  it("returns the RAW value when a string is exactly one expression", () => {
    const [out] = expand([{ n: "${input.count}", list: "${input.items}" }], {
      count: 3,
      items: ["a"],
    });
    // Not "3" — the catalog's schemas are strict about types, so a number has to stay a number.
    expect(out?.n).toBe(3);
    expect(out?.list).toEqual(["a"]);
  });

  it("interpolates when the string has surrounding text", () => {
    const [out] = expand([{ t: "Hi ${input.name}, ${input.n} left" }], { name: "Ada", n: 2 });
    expect(out?.t).toBe("Hi Ada, 2 left");
  });

  it("renders a missing or null value as empty rather than 'undefined'", () => {
    const [out] = expand([{ t: "x${input.nope}y" }], {});
    expect(out?.t).toBe("xy");
  });

  it("exposes the surface id", () => {
    const [out] = expand([{ id: "${surfaceId}" }], {});
    expect(out?.id).toBe("s1");
  });

  it("drops a key whose value expanded to nothing (an absent prop ≠ an undefined one)", () => {
    const [out] = expand([{ keep: "y", gone: { $if: "input.no", then: "x" } }], {});
    expect(out).toEqual({ keep: "y" });
  });

  it("cannot reach a prototype member", () => {
    // Both resolve to undefined, so a whole-expression value drops its key entirely and an
    // interpolated one renders empty — a path can't walk out of the data it was handed.
    const [dropped] = expand([{ a: "${input.constructor}", b: "${input.__proto__.x}" }], {});
    expect(dropped).toEqual({});
    const [blank] = expand([{ a: "<${input.constructor}>" }], {});
    expect(blank).toEqual({ a: "<>" });
  });

  it("reads nested paths and array indices", () => {
    const [out] = expand([{ t: "${input.a.b.1}" }], { a: { b: ["x", "y"] } });
    expect((out as { t: string }).t).toBe("y");
  });
});

describe("expandTemplate: $each", () => {
  it("splices one copy per item, with the alias and @index in scope", () => {
    const out = expand([{ $each: "input.xs", as: "x", body: { id: "n_${@index}", v: "${x}" } }], {
      xs: ["a", "b"],
    });
    expect(out).toEqual([
      { id: "n_0", v: "a" },
      { id: "n_1", v: "b" },
    ]);
  });

  it("splices nothing when the list is absent or not an array", () => {
    expect(expand([{ $each: "input.xs", body: { a: 1 } }], {})).toEqual([]);
    expect(expand([{ $each: "input.xs", body: { a: 1 } }], { xs: "no" })).toEqual([]);
  });

  it("flattens a body that expands to an array, so a nested $each stays flat", () => {
    const out = expand(
      [
        {
          $each: "input.rows",
          as: "row",
          index: "r",
          body: [
            { id: "row_${r}" },
            { $each: "row", as: "cell", body: { id: "cell_${r}_${@index}", t: "${cell}" } },
          ],
        },
      ],
      { rows: [["a", "b"], ["c"]] },
    );
    expect(out).toEqual([
      { id: "row_0" },
      { id: "cell_0_0", t: "a" },
      { id: "cell_0_1", t: "b" },
      { id: "row_1" },
      { id: "cell_1_0", t: "c" },
    ]);
  });

  it("keeps a named index readable after an inner loop rebinds @index", () => {
    // Without `index`, both loops would write `@index` and the ids would collide.
    const out = expand(
      [
        {
          $each: "input.rows",
          as: "row",
          index: "r",
          body: { $each: "row", as: "c", body: "${r}:${@index}" },
        },
      ],
      { rows: [["a", "b"], ["c"]] },
    );
    expect(out).toEqual(["0:0", "0:1", "1:0"]);
  });

  it("becomes the array itself in a property position (a children list)", () => {
    const [out] = expand([{ children: { $each: "input.xs", as: "x", body: "id_${@index}" } }], {
      xs: ["a", "b", "c"],
    });
    expect(out).toEqual({ children: ["id_0", "id_1", "id_2"] });
  });
});

describe("expandTemplate: $if", () => {
  it("branches on truthiness and omits an absent branch", () => {
    expect(expand([{ $if: "input.on", then: { a: 1 }, else: { a: 2 } }], { on: true })).toEqual([
      { a: 1 },
    ]);
    expect(expand([{ $if: "input.on", then: { a: 1 }, else: { a: 2 } }], { on: false })).toEqual([
      { a: 2 },
    ]);
    expect(expand([{ $if: "input.on", then: { a: 1 } }], {})).toEqual([]);
  });

  it("branches on equality when `equals` is given", () => {
    const template = [
      {
        $each: "input.fs",
        as: "f",
        body: { $if: "f.type", equals: "checkbox", then: { c: "box" }, else: { c: "text" } },
      },
    ];
    expect(expand(template, { fs: [{ type: "checkbox" }, { type: "shortText" }] })).toEqual([
      { c: "box" },
      { c: "text" },
    ]);
  });

  it("keeps a `false` literal branch instead of dropping it as empty", () => {
    // Seeding a CheckBox's data path with `false` depends on this: `false` is a value, not absence.
    const [out] = expand(
      [{ value: { $if: "input.t", equals: "checkbox", then: false, else: "" } }],
      {
        t: "checkbox",
      },
    );
    expect(out).toEqual({ value: false });
  });
});

describe("checkTemplateInput", () => {
  const schema = {
    type: "object",
    required: ["question", "options"],
    properties: {
      question: { type: "string" },
      options: { type: "array" },
      multi: { type: "boolean" },
      count: { type: "integer" },
    },
  };

  it("passes a well-formed input", () => {
    expect(checkTemplateInput(schema, { question: "q", options: [], multi: true })).toEqual([]);
  });

  it("names a missing required field (the error the model can act on)", () => {
    expect(checkTemplateInput(schema, { options: [] })).toEqual(["question: required"]);
  });

  it("catches a wrong top-level type, including array vs object", () => {
    const issues = checkTemplateInput(schema, { question: "q", options: {} });
    expect(issues).toEqual(["options: expected array, got object"]);
  });

  it("accepts a number for an integer field", () => {
    expect(checkTemplateInput(schema, { question: "q", options: [], count: 2 })).toEqual([]);
  });
});

/** A resolution containing just the plugins given, in the order given. */
function resolution(manifests: PluginManifest[]): ResolvedPlugins {
  const plugins: ResolvedPlugin[] = manifests.map((manifest, i) => ({
    pluginId: `plugin-${i}`,
    installId: `install-${i}`,
    key: manifest.key,
    version: manifest.version,
    source: manifest.key.startsWith("local:") ? "local" : "builtin",
    displayName: manifest.displayName,
    description: manifest.description,
    manifest,
    config: {},
  }));
  return {
    plugins,
    byKey: new Map(plugins.map((p) => [p.key, p])),
    toolNames: new Set(),
    providedToolNames: new Set(),
  };
}

const UI_MANIFEST = BUILTIN_MANIFESTS.find((m) => m.key === "@ibot/ui")!;

describe("collectUiTemplates", () => {
  it("ids a template as <plugin>.<name>", () => {
    const ids = collectUiTemplates(resolution([UI_MANIFEST])).map((t) => t.id);
    expect(ids).toContain("ibot_ui.render_choice");
    expect(ids).toContain("ibot_ui.render_form");
    expect(ids).toContain("ibot_ui.render_table");
  });

  it("lets a later plugin win an id collision (local shadows builtin)", () => {
    const shadow = {
      ...UI_MANIFEST,
      key: "@ibot/ui",
      ui: [{ ...UI_MANIFEST.ui[0]!, description: "mine" }],
    };
    const templates = collectUiTemplates(resolution([UI_MANIFEST, shadow]));
    const choice = templates.filter((t) => t.id === "ibot_ui.render_choice");
    expect(choice).toHaveLength(1);
    expect(choice[0]?.description).toBe("mine");
  });
});

/** What `render_card` hands back, in the shape these tests assert on. */
interface CardResult {
  ok: boolean;
  a2ui?: unknown[];
  errors?: { issues: string[] }[];
}

/** Call the built tool the way the SDK would: `(input, {toolCallId, …})`. */
async function callCard(
  templates: readonly UiTemplate[],
  input: { template: string; input?: Record<string, unknown> },
): Promise<CardResult> {
  const card = buildRenderCardTool(templates);
  expect(card).not.toBeNull();
  const execute = card!.execute as unknown as (
    args: unknown,
    opts: { toolCallId: string; messages: [] },
  ) => Promise<CardResult>;
  return execute({ input: {}, ...input }, { toolCallId: "call-1", messages: [] });
}

describe("render_card", () => {
  const templates = collectUiTemplates(resolution([UI_MANIFEST]));

  it("is not built at all when no plugin declares a template", () => {
    expect(buildRenderCardTool([])).toBeNull();
  });

  it("lists every template id in its description, so the enum needs no prose", () => {
    const description = (buildRenderCardTool(templates) as { description?: string }).description;
    for (const t of templates) expect(description).toContain(t.id);
  });

  it("rejects an unknown template by naming the available ones", async () => {
    const out = await callCard(templates, { template: "nope" });
    expect(out.ok).toBe(false);
    expect(out.errors?.[0]?.issues[0]).toContain("ibot_ui.render_choice");
  });

  it("rejects a call missing a required input field, before expanding", async () => {
    const out = await callCard(templates, {
      template: "ibot_ui.render_choice",
      input: { options: [] },
    });
    expect(out.ok).toBe(false);
    expect(out.errors?.[0]?.issues).toEqual(["question: required"]);
  });

  it("scopes the surface id to the tool call, so two cards stay separate surfaces", async () => {
    const out = await callCard(templates, {
      template: "ibot_ui.render_choice",
      input: { question: "q", options: [{ label: "A", value: "a" }] },
    });
    const created = (out.a2ui as { createSurface?: { surfaceId?: string } }[])[0];
    expect(created?.createSurface?.surfaceId).toContain("call-1");
  });

  it("refuses a card the client would fail to render", async () => {
    // A template whose root is missing: exactly what `validateA2uiMessages` exists to catch, proving
    // an expanded template is held to the same bar as a hand-written render_ui panel.
    const bad: UiTemplate = {
      id: "t.bad",
      pluginKey: "t",
      pluginDisplayName: "t",
      name: "bad",
      description: "",
      input: { type: "object" },
      template: [
        { version: "v0.9", createSurface: { surfaceId: "${surfaceId}", catalogId: "c" } },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "${surfaceId}",
            components: [{ id: "notroot", component: "Text", text: "hi" }],
          },
        },
      ] as never,
    };
    const out = await callCard([bad], { template: "t.bad" });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.errors)).toContain("root");
  });
});

/**
 * The shipped templates, expanded against realistic input and validated exactly as the render path
 * validates a hand-written panel. This is what catches a typo in template DATA, which no type can.
 */
describe("the @ibot/ui templates render", () => {
  const templates = collectUiTemplates(resolution([UI_MANIFEST]));
  const byId = new Map(templates.map((t) => [t.id, t]));

  const cases: { id: string; input: Record<string, unknown> }[] = [
    {
      id: "ibot_ui.render_choice",
      input: {
        question: "Which environment?",
        options: [
          { label: "Staging", value: "staging", hint: "safe" },
          { label: "Production", value: "prod" },
        ],
      },
    },
    {
      id: "ibot_ui.render_choice",
      input: {
        question: "Pick any",
        options: [{ label: "A", value: "a" }],
        multi: true,
        submitLabel: "Go",
      },
    },
    {
      id: "ibot_ui.render_form",
      input: {
        title: "Connect",
        fields: [
          { name: "host", label: "Host" },
          { name: "port", label: "Port", type: "number" },
          { name: "token", label: "Token", type: "obscured" },
          { name: "notes", label: "Notes", type: "longText" },
          { name: "tls", label: "Use TLS", type: "checkbox" },
          {
            name: "region",
            label: "Region",
            type: "select",
            options: [{ label: "EU", value: "eu" }],
          },
        ],
      },
    },
    // no title, one field: the `$if`-omitted branches have to still leave a valid children list
    { id: "ibot_ui.render_form", input: { fields: [{ name: "q", label: "Q" }] } },
    {
      id: "ibot_ui.render_table",
      input: {
        title: "Files",
        columns: ["name", "size"],
        rows: [
          ["a.txt", "1 KB"],
          ["b.txt", "2 KB"],
        ],
      },
    },
    { id: "ibot_ui.render_table", input: { columns: ["only"], rows: [] } },
  ];

  for (const { id, input } of cases) {
    it(`${id} with ${Object.keys(input).join("+")}`, () => {
      const template = byId.get(id)!;
      expect(checkTemplateInput(template.input, input)).toEqual([]);
      const messages = expandTemplate(template.template as never, { input, surfaceId: "surf-1" });
      const result = validateA2uiMessages(messages);
      // Print the issues rather than a bare `false` when this fails.
      expect(result.errors ?? []).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it("gives every component a unique id, in every template", () => {
    for (const { id, input } of cases) {
      const template = byId.get(id)!;
      const messages = expandTemplate(template.template as never, { input, surfaceId: "surf-1" });
      const ids = messages.flatMap((m) => {
        const update = (m as { updateComponents?: { components?: { id?: string }[] } })
          .updateComponents;
        return (update?.components ?? []).map((c) => c.id);
      });
      expect(new Set(ids).size, `${id} has duplicate component ids`).toBe(ids.length);
    }
  });

  it("references only ids it actually defines", () => {
    // A `child`/`children` pointing at a missing id renders as a hole, and the catalog schemas
    // can't see it — the reference is a plain string to them.
    for (const { id, input } of cases) {
      const template = byId.get(id)!;
      const messages = expandTemplate(template.template as never, { input, surfaceId: "surf-1" });
      const components = messages.flatMap((m) => {
        const update = (m as { updateComponents?: { components?: Record<string, unknown>[] } })
          .updateComponents;
        return update?.components ?? [];
      });
      const defined = new Set(components.map((c) => c.id as string));
      for (const component of components) {
        const referenced = [
          ...(typeof component.child === "string" ? [component.child] : []),
          ...(Array.isArray(component.children) ? (component.children as string[]) : []),
        ];
        for (const ref of referenced) {
          expect(defined.has(ref), `${id}: ${String(component.id)} → missing "${ref}"`).toBe(true);
        }
      }
    }
  });
});

describe("resolution exposes the card tool", () => {
  it("adds exactly one tool name however many templates are live", async () => {
    const { resolvePluginsForBot } = await import("./resolve.js");
    const db = {
      query: {
        bots: { findFirst: async () => ({ ownerId: "u1" }) },
        pluginInstalls: {
          findMany: async () => [
            {
              id: "i1",
              pluginId: "p1",
              ownerType: "user",
              ownerId: "u1",
              enabled: true,
              enabledBots: null,
              config: {},
            },
          ],
        },
        plugins: {
          findMany: async () => [
            {
              id: "p1",
              key: UI_MANIFEST.key,
              version: UI_MANIFEST.version,
              source: "builtin",
              displayName: UI_MANIFEST.displayName,
              description: UI_MANIFEST.description,
              manifest: UI_MANIFEST,
              contentHash: "h",
            },
          ],
        },
      },
    };
    const resolved = await resolvePluginsForBot(db as never, "bot-1");
    expect(UI_MANIFEST.ui.length).toBeGreaterThan(1);
    expect([...resolved.toolNames]).toEqual([RENDER_CARD_TOOL]);
  });
});

describe("templateId", () => {
  it("sanitizes both halves so the id survives a scoped key", () => {
    expect(templateId("@ibot/ui", "render_choice")).toBe("ibot_ui.render_choice");
    expect(templateId("local:0b1f4c2e-1111", "card")).toMatch(/^[a-zA-Z0-9_-]+\.card$/);
  });
});
