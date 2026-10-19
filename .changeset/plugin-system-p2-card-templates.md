---
"@i-bot/types": minor
---

Plugin system, phase 2: card templates, reached through **one** tool. A plugin declares A2UI with
`${input.x}` holes in it; the model calls `render_card({template, input})` and the platform expands it.
This is the step that stops the model hand-writing component trees for the cards it draws most often.
(Design: `docs/plugin-system-design.md`, P2.)

- **One tool, not one per template.** The design called for a `ui__<plugin>__<name>` tool per
  declaration. Built that way, every template's name, description and JSON Schema would ship in the
  system prompt on **every** request — ten installed templates is ten schemas of fixed overhead
  whether or not the turn draws a card — and the model's tool list would grow with whatever the user
  happened to install, differently per bot. So a template is data passed to `render_card`, and
  `template` is an enum of the live ids, which puts the valid values in the schema instead of in prose.
  Adding a template now costs one enum member. The cost of the trade is that per-template input types
  can't live in the schema, so `input` is a loose object checked at call time — needed regardless,
  since a template's `input` is plugin-authored JSON Schema that can't be compiled into TypeScript.

- **Everything about templates lives in one module** (`plugins/ui-templates.ts`): the expander, the
  input guard, the catalog, the tool. `agent/tools.ts` still doesn't know plugins exist, and the run
  loop's whole involvement is two lines next to where it merges MCP tools.

- **The expander substitutes; it does not evaluate.** No JS, no calls, and a path can only read own
  properties of the data it was handed, so it can't reach a prototype member or walk out of scope. A
  string that is exactly one expression yields the **raw** value (a number stays a number — the
  catalog's schemas are strict), anything else interpolates. Two directives, both earning their place:
  `$each` (A2UI components are a flat adjacency list, so a list of options or rows is impossible
  without repetition, and each copy needs its own id) and `$if` — with `equals`, which is what lets a
  single template render a list of differently-typed form fields. Expanded output goes through the
  **same** `validateA2uiMessages` as a hand-written `render_ui` panel, so a template can't produce a
  surface the escape hatch couldn't, and a bad card comes back as `{ok:false, errors}` for the model to
  fix in the same turn.

- **`@ibot/ui`**, the second builtin: `render_choice`, `render_form`, `render_table`, plus the skill
  that says when to draw a card at all — including that read-only tabular data belongs in a markdown
  table, which streams and costs a fraction of a card. That guidance moves out of `PLATFORM_PROMPT`,
  where it was unconditional, into a plugin the user can switch off. Unlike core, this one **can** be
  switched off: a bot that should only ever reply in prose has no use for it, and turning it off takes
  the templates and the skill together. Verified that it does remove the tool, not just hide it.

- `PluginUiDecl.template` loosens from `A2uiMessage[]` to a plain record array, because before
  expansion an entry may be a directive rather than a message and carries no `version`. The strictness
  lands where it matters: on the expanded result.

Templates are data, so a typo in one (a bad `variant`, a `child` id that doesn't exist, a prop the
strict catalog rejects) is invisible to TypeScript and would surface as a card stuck at
`[Loading root...]` in front of a user. So each shipped template is expanded against realistic input
in tests and validated against the real catalog, with two extra sweeps — every component id unique,
every `child`/`children` reference actually defined — since a dangling reference is just a string to
the schemas. Verified live against Postgres and a running server too: both builtins sync idempotently,
all 8 existing users have the install, a real bot resolves `core + ui + local` with exactly one
`render_card` in its tool names however many templates are live, a real `render_form` call expands to a
valid six-message panel, a missing required field comes back as `question: required`, and
`GET /bots/:botId/plugins` reports each card's template id against the one tool name.
