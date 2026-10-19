/**
 * Builtin plugins: the capabilities we ship with the code, synced into the DB on boot so they travel
 * the exact same assembly path as anything a user installs. There is no special case at run time — a
 * builtin is just a `plugins` row whose `source` is `builtin`.
 *
 * P1 ships one: `@ibot/core`, the DECLARATION of the nine primitives. Their implementations stay in
 * `agent/tools.ts` and are not moved here — moving working code to satisfy a shape would cost
 * readability and buy nothing. What the row buys is real: "core is a plugin too" becomes true in the
 * data, the UI can list what a bot has without a hardcoded list, and an agent's tool allowlist has a
 * vocabulary to validate against.
 *
 * Declarations are typed TS objects rather than on-disk directories. The directory importer (P3)
 * produces the same `PluginManifest`, so when it lands these become `apps/api/plugins/<key>/` and
 * this file turns into a loader — no format change, and nothing downstream notices.
 */
import type { Database } from "@i-bot/db";
import { pluginInstalls } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import { PluginManifest } from "@i-bot/types";
import type { z } from "zod";
import { CORE_TOOLS } from "../agent/tools.js";
import { normalizeManifest } from "./manifest.js";
import { ensureInstall, ensureLocalPlugin, upsertPlugin } from "./repository.js";
import { CORE_PLUGIN_KEY } from "./resolve.js";

/**
 * Fill in the manifest fields a hand-written declaration shouldn't have to repeat.
 *
 * The param is the schema's INPUT type (`z.input`), i.e. pre-defaults — on the output type every
 * array and flag is already required, so a literal like `{name, description, playbook}` for a skill
 * wouldn't typecheck even though it's exactly what the contract accepts.
 */
function declare(partial: z.input<typeof PluginManifest>): PluginManifest {
  // Parse through the contract so a builtin gets the same validation as an imported bundle — a typo
  // in our own declaration should fail at boot, not at first use.
  return normalizeManifest(partial, { source: "builtin" });
}

/**
 * `@ibot/core` — the nine primitives every bot has. Cannot be switched off (`resolvePluginsForBot`
 * keeps it live regardless of the install's `enabled` flag), which is why it carries no skills or
 * templates: it describes what the agent IS, and the run loop's platform prompt already teaches how
 * to use it.
 */
const CORE: PluginManifest = declare({
  key: CORE_PLUGIN_KEY,
  version: "1.0.0",
  displayName: "核心能力",
  description:
    "每个 bot 都有的九个原语:浏览器、桌面、截图、卡片、shell、技能记录、MCP 绑定、后台任务、人工接手。不可关闭。",
  defaultEnabled: true,
  providedTools: CORE_TOOLS.map((t) => ({ name: t.name, description: t.description })),
});

/**
 * The A2UI catalog every surface is rendered against. The client pins incoming `createSurface`
 * messages to its own registered catalog id anyway, but declaring the real one keeps a template
 * honest about what components it may use.
 */
const CATALOG_ID = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

/**
 * `@ibot/ui` — the card templates. Three of them cover most of what a chat card is ever for: pick
 * something, fill something in, look at a table. The model reaches all three through the single
 * `render_card` tool (see `ui-templates.ts` for why one tool and not one per template), and
 * `render_ui` stays as the escape hatch for a layout none of these can express.
 *
 * Each template is A2UI with `${input.x}` holes and `$each` / `$if` directives. Read them as the
 * finished card with the variable parts marked: `root` is a Card wrapping a Column, controls bind
 * their value into the data model, and the submit Button sends the whole model back as the event
 * context — so the model gets the filled-in values as a normal message.
 *
 * Unlike core, this one CAN be switched off: a bot that should only ever reply in prose has no use
 * for it, and turning it off takes the three templates and the skill with it in one move.
 */
const UI: PluginManifest = declare({
  key: "@ibot/ui",
  version: "1.0.0",
  displayName: "卡片模板",
  description:
    "三个现成的交互卡片:选项、表单、表格。模型用 render_card 填数据即可,不用手写 A2UI 组件树。关掉后只剩 render_ui 逃生口。",
  defaultEnabled: true,
  skills: [
    {
      name: "卡片还是散文",
      description: "什么时候画卡片、什么时候直接说,以及只读表格为什么用 markdown。",
      playbook: [
        "Reply in prose by default. A card is for something the user ACTS on or needs laid out;",
        "it is not a nicer font for a sentence.",
        "",
        "- **Prose** — an answer, a status, a short explanation, one or two facts. Most replies.",
        "- **A markdown table** — read-only tabular data (a list of files, a comparison, query",
        "  results). It streams as you type it and costs a fraction of a card's tokens, so prefer it",
        "  over `render_card` with `ibot_ui.render_table` unless the table belongs INSIDE a card the",
        "  user is also acting on.",
        "- **A card** (`render_card`) — the user has to choose, type, or confirm something, or a",
        "  result needs real structure. `ibot_ui.render_choice` to pick from options,",
        "  `ibot_ui.render_form` to collect several fields at once, `ibot_ui.render_table` for a",
        "  table that's part of an interaction.",
        "- **`render_ui`** — only when no template fits. You hand-write the components then.",
        "",
        "Say a line of prose before the card, so the user reads why it's there. One card per thing",
        "being asked — don't stack three cards in one reply.",
      ].join("\n"),
    },
  ],
  ui: [
    {
      name: "render_choice",
      description: "Ask the user to pick from a list of options (single or multiple choice).",
      input: {
        type: "object",
        required: ["question", "options"],
        properties: {
          question: { type: "string", description: "What you're asking them to choose." },
          options: {
            type: "array",
            description: "The choices. `hint` is an optional second line on the option.",
            items: {
              type: "object",
              required: ["label", "value"],
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                hint: { type: "string" },
              },
            },
          },
          multi: { type: "boolean", description: "true = they may pick several. Default false." },
          submitLabel: { type: "string", description: 'Button text. Default "Confirm".' },
        },
      },
      template: [
        { version: "v0.9", createSurface: { surfaceId: "${surfaceId}", catalogId: CATALOG_ID } },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "${surfaceId}",
            components: [
              { id: "root", component: "Card", child: "body" },
              { id: "body", component: "Column", children: ["question", "picker", "actions"] },
              { id: "question", component: "Text", text: "${input.question}", variant: "h5" },
              {
                id: "picker",
                component: "ChoicePicker",
                // The catalog's option schema is strict (`label` + `value` only), so the optional
                // `hint` is folded into the label rather than passed through as an extra key.
                options: {
                  $each: "input.options",
                  as: "opt",
                  body: {
                    label: {
                      $if: "opt.hint",
                      then: "${opt.label} — ${opt.hint}",
                      else: "${opt.label}",
                    },
                    value: "${opt.value}",
                  },
                },
                variant: {
                  $if: "input.multi",
                  then: "multipleSelection",
                  else: "mutuallyExclusive",
                },
                value: { path: "/choice" },
              },
              { id: "actions", component: "Row", justify: "end", children: ["submit"] },
              {
                id: "submitLabel",
                component: "Text",
                text: { $if: "input.submitLabel", then: "${input.submitLabel}", else: "Confirm" },
              },
              {
                id: "submit",
                component: "Button",
                child: "submitLabel",
                variant: "primary",
                action: { event: { name: "choice", context: { choice: { path: "/choice" } } } },
              },
            ],
          },
        },
        // Seed the bound path so the picker starts with a real (empty) selection rather than an
        // unresolved binding.
        { version: "v0.9", updateDataModel: { surfaceId: "${surfaceId}", path: "/", value: {} } },
        {
          version: "v0.9",
          updateDataModel: { surfaceId: "${surfaceId}", path: "/choice", value: [] },
        },
      ],
    },
    {
      name: "render_form",
      description: "Collect several fields at once (text, number, password, checkbox, select).",
      input: {
        type: "object",
        required: ["fields"],
        properties: {
          title: { type: "string" },
          fields: {
            type: "array",
            description: "One control each, in order.",
            items: {
              type: "object",
              required: ["name", "label"],
              properties: {
                name: { type: "string", description: "Key this field's value comes back under." },
                label: { type: "string" },
                type: {
                  type: "string",
                  description:
                    'One of "shortText" (default), "longText", "number", "obscured", ' +
                    '"checkbox", "select".',
                },
                options: {
                  type: "array",
                  description: 'Required for type "select".',
                  items: {
                    type: "object",
                    required: ["label", "value"],
                    properties: { label: { type: "string" }, value: { type: "string" } },
                  },
                },
              },
            },
          },
          submitLabel: { type: "string", description: 'Button text. Default "Submit".' },
        },
      },
      template: [
        { version: "v0.9", createSurface: { surfaceId: "${surfaceId}", catalogId: CATALOG_ID } },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "${surfaceId}",
            components: [
              { id: "root", component: "Card", child: "body" },
              {
                id: "body",
                component: "Column",
                // Children are ids, so the list has to be built in the same order the components
                // are: optional title, one per field, then the actions row.
                children: [
                  { $if: "input.title", then: "title" },
                  { $each: "input.fields", as: "f", body: "field_${@index}" },
                  "actions",
                ],
              },
              {
                $if: "input.title",
                then: { id: "title", component: "Text", text: "${input.title}", variant: "h5" },
              },
              // One control per field. `$if … equals` is what lets a single template render a list
              // of differently-typed fields — truthiness alone can't tell "checkbox" from "select".
              {
                $each: "input.fields",
                as: "f",
                body: {
                  $if: "f.type",
                  equals: "checkbox",
                  then: {
                    id: "field_${@index}",
                    component: "CheckBox",
                    label: "${f.label}",
                    value: { path: "/${f.name}" },
                  },
                  else: {
                    $if: "f.type",
                    equals: "select",
                    then: {
                      id: "field_${@index}",
                      component: "ChoicePicker",
                      label: "${f.label}",
                      variant: "mutuallyExclusive",
                      options: {
                        $each: "f.options",
                        as: "opt",
                        body: { label: "${opt.label}", value: "${opt.value}" },
                      },
                      value: { path: "/${f.name}" },
                    },
                    else: {
                      id: "field_${@index}",
                      component: "TextField",
                      label: "${f.label}",
                      variant: { $if: "f.type", then: "${f.type}", else: "shortText" },
                      value: { path: "/${f.name}" },
                    },
                  },
                },
              },
              { id: "actions", component: "Row", justify: "end", children: ["submit"] },
              {
                id: "submitLabel",
                component: "Text",
                text: { $if: "input.submitLabel", then: "${input.submitLabel}", else: "Submit" },
              },
              {
                id: "submit",
                component: "Button",
                child: "submitLabel",
                variant: "primary",
                // The whole data model comes back, so every field arrives under its own `name`.
                action: { event: { name: "form", context: { form: { path: "/" } } } },
              },
            ],
          },
        },
        { version: "v0.9", updateDataModel: { surfaceId: "${surfaceId}", path: "/", value: {} } },
        // Seed each field's own path with an empty value of the right TYPE — a CheckBox bound to a
        // missing path has no state to toggle, and a ChoicePicker needs an array.
        {
          $each: "input.fields",
          as: "f",
          body: {
            version: "v0.9",
            updateDataModel: {
              surfaceId: "${surfaceId}",
              path: "/${f.name}",
              value: {
                $if: "f.type",
                equals: "checkbox",
                then: false,
                else: { $if: "f.type", equals: "select", then: [], else: "" },
              },
            },
          },
        },
      ],
    },
    {
      name: "render_table",
      description:
        "A table inside a card. For a READ-ONLY table prefer a markdown table in your reply — it " +
        "streams and costs far fewer tokens. Use this when the table is part of a card.",
      input: {
        type: "object",
        required: ["columns", "rows"],
        properties: {
          title: { type: "string" },
          columns: { type: "array", description: "Header cells.", items: { type: "string" } },
          rows: {
            type: "array",
            description: "One array of cell STRINGS per row, in column order.",
            items: { type: "array", items: { type: "string" } },
          },
        },
      },
      template: [
        { version: "v0.9", createSurface: { surfaceId: "${surfaceId}", catalogId: CATALOG_ID } },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "${surfaceId}",
            components: [
              { id: "root", component: "Card", child: "body" },
              {
                id: "body",
                component: "Column",
                children: [
                  { $if: "input.title", then: "title" },
                  "header",
                  { $each: "input.rows", as: "row", body: "row_${@index}" },
                ],
              },
              {
                $if: "input.title",
                then: { id: "title", component: "Text", text: "${input.title}", variant: "h5" },
              },
              {
                id: "header",
                component: "Row",
                children: { $each: "input.columns", as: "col", body: "head_${@index}" },
              },
              {
                $each: "input.columns",
                as: "col",
                body: { id: "head_${@index}", component: "Text", text: "${col}", variant: "h5" },
              },
              // Nested loops: `index` names the OUTER counter, because the inner loop rebinds
              // `@index` to the cell position and the ids need both to stay unique.
              {
                $each: "input.rows",
                as: "row",
                index: "r",
                body: [
                  {
                    id: "row_${r}",
                    component: "Row",
                    children: { $each: "row", as: "cell", body: "cell_${r}_${@index}" },
                  },
                  {
                    $each: "row",
                    as: "cell",
                    body: { id: "cell_${r}_${@index}", component: "Text", text: "${cell}" },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  ],
});

/** Every builtin, in the order they're synced. */
export const BUILTIN_MANIFESTS: readonly PluginManifest[] = [CORE, UI];

/** What one sync pass did, for the boot log. */
export interface SyncResult {
  /** plugin rows created or refreshed */
  plugins: number;
  /** installs created (an existing install is never touched) */
  installs: number;
}

/**
 * Upsert every builtin plugin row, then make sure each existing user has an install of it. Safe to
 * run on every boot: `upsertPlugin` refreshes the same `(key, version)` row, and `ensureInstall`
 * leaves an existing install exactly as the user left it — so a builtin the user switched off stays
 * off across restarts.
 *
 * A user created AFTER this runs gets their installs when their first bot is created (see
 * `ensureBotPlugins`), so a new signup doesn't have to wait for a restart to have core.
 *
 * Never throws: a failure here must not stop the API from serving. The caller logs what came back.
 */
export async function syncBuiltinPlugins(
  db: Database,
  opts: { logger?: Logger } = {},
): Promise<SyncResult> {
  // One upsert per builtin, settled independently so a bad declaration is skipped with a log rather
  // than taking the rest of the sync down with it.
  const settled = await Promise.allSettled(
    BUILTIN_MANIFESTS.map((manifest) => upsertPlugin(db, { manifest, source: "builtin" })),
  );
  const rows = settled.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    opts.logger?.error(
      { plugin: BUILTIN_MANIFESTS[i]?.key, err: String(r.reason) },
      "builtin plugin upsert failed",
    );
    return [];
  });

  const allUsers = await db.query.users.findMany({ columns: { id: true } }).catch(() => []);
  // Installs go in as ONE bulk insert rather than a call per (user, plugin): this runs on every boot,
  // and the pair-wise version is O(users × builtins) round trips — fine at ten users, a slow boot at
  // ten thousand. `onConflictDoNothing` against the unique index is what makes it idempotent, and it
  // also means an install the user has customised (switched off, narrowed to some bots) is left
  // exactly as they set it.
  const installs = allUsers.flatMap((user) =>
    rows.map((plugin) => ({
      pluginId: plugin.id,
      ownerType: "user" as const,
      ownerId: user.id,
      // core is mandatory; every other builtin respects its own default.
      enabled: plugin.key === CORE_PLUGIN_KEY ? true : plugin.manifest.defaultEnabled,
      enabledBots: null,
      config: {},
    })),
  );

  let created = 0;
  if (installs.length > 0) {
    try {
      const inserted = await db
        .insert(pluginInstalls)
        .values(installs)
        .onConflictDoNothing({
          target: [pluginInstalls.pluginId, pluginInstalls.ownerType, pluginInstalls.ownerId],
        })
        .returning({ id: pluginInstalls.id });
      created = inserted.length;
    } catch (err) {
      opts.logger?.error(
        { count: installs.length, err: err instanceof Error ? err.message : err },
        "builtin plugin installs failed",
      );
    }
  }
  return { plugins: rows.length, installs: created };
}

/**
 * Make sure one bot is ready to resolve plugins: its owner has every builtin install, and the bot has
 * its own `local` plugin. Called when a bot is created (and by the backfill for bots that predate
 * plugins), so a brand-new bot's first turn already resolves a complete capability set.
 *
 * Never throws — a bot that fails this is still a working bot with the nine primitives.
 */
export async function ensureBotPlugins(
  db: Database,
  input: { botId: string; ownerId: string; botName?: string; logger?: Logger },
): Promise<void> {
  try {
    // Builtins are independent of each other, so upsert + install them concurrently. The list is
    // small (one today) and each pair is idempotent, so there's no ordering to preserve.
    await Promise.all(
      BUILTIN_MANIFESTS.map(async (manifest) => {
        const plugin = await upsertPlugin(db, { manifest, source: "builtin" });
        await ensureInstall(db, {
          pluginId: plugin.id,
          ownerId: input.ownerId,
          enabled: plugin.key === CORE_PLUGIN_KEY ? true : manifest.defaultEnabled,
        });
      }),
    );
    await ensureLocalPlugin(db, {
      botId: input.botId,
      ownerId: input.ownerId,
      ...(input.botName ? { botName: input.botName } : {}),
    });
  } catch (err) {
    input.logger?.error(
      { botId: input.botId, err: err instanceof Error ? err.message : err },
      "ensureBotPlugins failed",
    );
  }
}
