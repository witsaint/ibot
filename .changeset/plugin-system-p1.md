---
"@i-bot/types": minor
"@i-bot/db": minor
---

Plugin system, phase 1: make **plugin** the packaging unit for capability — data model, per-bot
resolution, and the first builtin. Skills, MCP servers, agents, card templates, setup steps, hooks and
carried files stop being four things mounted four ways and become one bundle that installs, enables,
upgrades and uninstalls as a whole. (Design: `docs/plugin-system-design.md`; this is its P1.)

- **The contract** (`@i-bot/types`): `PluginManifest` — the normalized shape every import path
  produces, so runtime assembly reads exactly one format. It is pure DATA by construction: the
  platform parses, validates, stores and expands it, and never executes anything it contains. What a
  plugin carries that must RUN (a stdio MCP `command`, a `command` hook, setup steps, glue files) runs
  inside the owning bot's own sandbox — the same trust plane the model's `run_command` already has —
  which is what lets us accept the community Claude Code plugin format nearly whole while keeping
  "zero execution on the platform host" true. Also `Plugin`/`PluginInstall` row views, `PluginSource`
  (`builtin` | `installed` | `local`), `PLUGIN_LIMITS`, and the `sanitizePluginKey` /
  `localPluginKey` helpers shared by the runtime and the UI.

- **Schema** (`@i-bot/db`, migration `0007_plugins`): `plugins` (`unique(key, version)`, so an upgrade
  is a new row and rollback keeps the old one) and `plugin_installs`
  (`unique(plugin_id, owner_type, owner_id)`, `enabled_bots: null` = all of that owner's bots). Plus a
  nullable `plugin_id` FK on `skills` / `bot_mcp_servers` / `bot_setup_steps`, so an expanded row
  points back at what produced it and cascades away with it. Purely additive — every statement is
  `CREATE` or `ADD COLUMN … NULL`, and the old read paths keep working untouched, which is the whole
  rollback story.

- **Resolution**: `resolvePluginsForBot` answers "what can this bot do right now" —
  `core ∪ enabled builtin ∪ enabled installed (for this bot) ∪ its own local` — and the run loop,
  `GET /bots/:botId/plugins`, and (later) the composer menu all read that one function, so what the
  user is offered and what the model can call can't drift. Precedence `local > installed > builtin`
  resolves same-named skills to the copy closest to the user; a `hidden` skill (referenced only by a
  hook or an agent) stays out of the model's list; a row whose plugin was disabled stops contributing
  immediately even if the row outlived the disable.

- **Fixed a latent cross-tenant read in `loadBotSkills`.** Its `WHERE` was
  `(scope='bot' AND owner_ref=botId) OR scope='public'`, and `scope='public'` has no owner column — so
  any such row would have been readable by every tenant's bots. Nothing ever wrote one, so nothing
  leaked; but P1 starts expanding shared capability into skill rows, which would have turned a dormant
  shortcut into a real leak. The predicate is now a single owner-scoped `AND`, "public" moves up a
  level to a `builtin` plugin whose skills are materialized per bot, and a test asserts the removed
  branch by inspecting the generated SQL (verified by reintroducing the leak and watching it fail).

- **`@ibot/core`**, the first builtin: the declaration of the nine primitives, synced on boot and
  installed for every user. Their implementations stay in `agent/tools.ts` — moving working code to
  satisfy a shape would cost readability and buy nothing. The row is what makes "core is a plugin too"
  true in the data, gives the UI a list it doesn't hardcode, and gives an agent's tool allowlist a
  vocabulary to check against. It can't be switched off, enforced in resolution rather than by
  trusting a flag. Only a `builtin` may declare `providedTools`; the importer strips the field from
  anything else, since an imported bundle claiming a platform tool would be asserting a capability it
  can't back.

- **Every bot gets a `local` plugin** — the one editable bundle. `save_skill`, `bind_mcp` and
  `POST /skills` now stamp their rows with it, so a bot's recorded experience is a coherent set that
  can later be exported and shared instead of loose rows. All three degrade to a null `plugin_id`
  rather than failing when a bot doesn't have one yet.

- **API**: `GET /plugins`, `GET /plugins/:pluginId`, `GET /bots/:botId/plugins`. Reads only — install
  and upgrade wait for the importer, because "install" is only half a control-plane action and
  shipping the half that skips the box would report success for a plugin that isn't running. Detail
  resolves through the caller's own installs, so an id they have nothing to do with is a 404 rather
  than a confirmation it exists.

Verified live against Postgres and a running server, not just unit stubs: migration applied; builtin
sync idempotent across runs with a stable content hash; a real bot resolves core + local in precedence
order; a skill stamped into the local plugin loads and is visible, a sibling bot sees none of it, and
deleting the plugin cascades the row away; `GET /plugins` is 401 anonymous and another user's bot
snapshot is 404. The backfill script (`scripts/backfill-plugins.ts`) ran over the existing 3 bots,
adopting their rows, and a second run changed nothing.
