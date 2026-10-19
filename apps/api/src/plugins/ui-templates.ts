/**
 * Card templates → ONE tool.
 *
 * A plugin declares card templates (`manifest.ui[]`): an A2UI message array with `${input.x}` holes
 * in it. This module is the whole story for turning those declarations into something the model can
 * call — the expander, the input guard, the catalog, and the single tool definition. Nothing about
 * templates lives anywhere else: `tools.ts` doesn't know plugins exist, and the run loop merges the
 * one tool this module returns.
 *
 * ## Why one tool and not one tool per template
 *
 * The obvious shape is a `ui__<plugin>__<name>` tool per declaration. It reads well and it scales
 * badly: every tool's name, description and JSON Schema ships in the system prompt on EVERY request,
 * so ten installed templates is ten schemas of fixed overhead whether or not the turn draws a card,
 * and the model's tool list — the thing it has to scan to decide what to do — grows with what the
 * user happens to have installed. Worse, the set changes per bot, so nothing about the toolset is
 * stable enough to reason about.
 *
 * So templates are DATA passed to one tool: `render_card({ template, input })`. `template` is an enum
 * of the live template ids, which means the valid values are carried by the schema itself rather than
 * by prose, and adding a template costs one enum member and one line of description instead of a
 * whole tool. The cost is that per-template input types can't be expressed in the schema (one tool,
 * one schema), so `input` is a loose object and we validate it at call time — which we'd want anyway,
 * since a template's `input` is plugin-authored JSON Schema and not something we can compile into
 * TypeScript.
 *
 * ## The expander is not a template engine
 *
 * `expandTemplate` walks the declared JSON and substitutes. It does not evaluate: no JS, no calls, no
 * arbitrary property access beyond the scope it's handed. The output goes through the SAME
 * `validateA2uiMessages` the `render_ui` escape hatch uses, so a template can't produce a surface a
 * hand-written one couldn't. Two directives cover what cards actually need:
 *
 *   - `{"$each": "input.options", "as": "opt", "body": {…}}` — in an ARRAY position, expands to one
 *     copy of `body` per item, with `opt` and `@index` in scope. This is what makes a list of
 *     options, rows or fields possible at all, since A2UI components are a flat adjacency list and
 *     each needs its own id. A body that expands to an array is SPLICED, so a `$each` nested inside
 *     another's body (a table's cells inside its rows) flattens correctly; `index` names the counter
 *     when the default `@index` would be shadowed by an inner loop.
 *   - `{"$if": "input.multi", "then": {…}, "else": {…}}` — in any position, picks a branch on
 *     truthiness, or on equality when `equals` is given (`{"$if": "f.type", "equals": "checkbox"}`) —
 *     which is what lets one template render a list of differently-typed fields. `else` is optional;
 *     in an array position an omitted branch splices to nothing.
 *
 * And `${…}` in strings: `"${input.title}"` alone yields the RAW value (so a number stays a number
 * and an object stays an object), while `"Hi ${input.name}"` interpolates into a string. `${@index}`
 * is the loop counter, `${surfaceId}` the surface this call is drawing.
 */
import type { A2uiMessage } from "@i-bot/types";
import { sanitizePluginKey } from "@i-bot/types";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { validateA2uiMessages } from "../agent/a2ui-validate.js";
import type { ResolvedPlugins } from "./resolve.js";

/** The one tool every card template is reached through. */
export const RENDER_CARD_TOOL = "render_card";

/** A template id as the model names it: `<sanitized plugin key>.<name>`. */
export function templateId(pluginKey: string, uiName: string): string {
  return `${sanitizePluginKey(pluginKey)}.${sanitizePluginKey(uiName)}`;
}

/** One live template: the declaration plus where it came from. */
export interface UiTemplate {
  /** what the model passes as `template` */
  id: string;
  pluginKey: string;
  pluginDisplayName: string;
  name: string;
  description: string;
  /** plugin-authored JSON Schema for `input` — used for the guard and shown in the description */
  input: Record<string, unknown>;
  template: A2uiMessage[];
}

/**
 * Every card template live for this bot, later plugins winning an id collision (resolution order is
 * ascending precedence: `builtin` → `installed` → `local`, so a user's own copy of a template shadows
 * the shipped one — the same rule as same-named skills).
 */
export function collectUiTemplates(resolved: ResolvedPlugins): UiTemplate[] {
  const byId = new Map<string, UiTemplate>();
  for (const plugin of resolved.plugins) {
    for (const ui of plugin.manifest.ui) {
      const id = templateId(plugin.key, ui.name);
      byId.set(id, {
        id,
        pluginKey: plugin.key,
        pluginDisplayName: plugin.displayName,
        name: ui.name,
        description: ui.description,
        input: ui.input as Record<string, unknown>,
        template: ui.template as A2uiMessage[],
      });
    }
  }
  return [...byId.values()];
}

// ---------- expansion

/** What `${…}` paths resolve against. */
export interface ExpandScope {
  input: Record<string, unknown>;
  /** the surface this call draws — templates reference it as `${surfaceId}` */
  surfaceId: string;
  /** `$each` bindings, innermost last (`@index` lives here too) */
  vars?: Record<string, unknown>;
}

/** A directive node, before expansion. */
interface EachDirective {
  $each: string;
  /** name the item is bound to inside `body` (default `item`) */
  as?: string;
  /** name the counter is bound to; `@index` always works but is shadowed by an inner loop */
  index?: string;
  body: unknown;
}
interface IfDirective {
  $if: string;
  /** when present, branch on `$if === equals` instead of on truthiness */
  equals?: unknown;
  then?: unknown;
  else?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isEach(value: unknown): value is EachDirective {
  return isRecord(value) && typeof value.$each === "string";
}
function isIf(value: unknown): value is IfDirective {
  return isRecord(value) && typeof value.$if === "string";
}

/**
 * Resolve a dotted path against the scope. `input.a.b` reads the model's input, `@index` and a
 * `$each` alias read loop bindings, `surfaceId` the current surface. Returns `undefined` for anything
 * missing — a hole in a card is a blank, not a crash.
 *
 * Only own enumerable properties of plain objects and array indices are readable: a path can't reach
 * a prototype member (`constructor`, `__proto__`) and so can't walk out of the data it was given.
 */
function resolvePath(path: string, scope: ExpandScope): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(".");
  const head = parts[0]!;

  let current: unknown;
  if (head === "surfaceId") current = scope.surfaceId;
  else if (head === "input") current = scope.input;
  else if (scope.vars && Object.hasOwn(scope.vars, head)) current = scope.vars[head];
  else return undefined;

  for (const key of parts.slice(1)) {
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** `${…}` occurrences in a string. */
const EXPRESSION = /\$\{([^}]*)\}/g;

/**
 * Substitute a string. A string that is EXACTLY one expression yields the raw resolved value, so
 * `"value": "${input.count}"` stays a number and `"${input.rows}"` stays an array — the A2UI
 * component schemas are strict about types, and stringifying everything would fail them. Any other
 * string interpolates, with `null`/`undefined` rendering as empty rather than "null".
 */
function substitute(text: string, scope: ExpandScope): unknown {
  const whole = /^\$\{([^}]*)\}$/.exec(text);
  if (whole) return resolvePath(whole[1]!, scope);
  return text.replace(EXPRESSION, (_match, path: string) => {
    const value = resolvePath(path, scope);
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Bindings for one iteration of a `$each`. */
function loopScope(directive: EachDirective, entry: unknown, index: number, scope: ExpandScope) {
  const vars: Record<string, unknown> = {
    ...scope.vars,
    [directive.as ?? "item"]: entry,
    "@index": index,
  };
  // An explicitly named counter survives an inner loop rebinding `@index` — required for nested
  // loops (table rows × cells), where colliding counters would produce duplicate component ids.
  if (directive.index) vars[directive.index] = index;
  return { ...scope, vars };
}

/** Pick a `$if` branch: on equality when `equals` is given, else on truthiness. */
function ifBranch(directive: IfDirective, scope: ExpandScope): unknown {
  const value = resolvePath(directive.$if, scope);
  const taken = "equals" in directive ? value === directive.equals : Boolean(value);
  return taken ? directive.then : directive.else;
}

/**
 * Directive expansion inside an array: `$each` splices many, `$if` splices zero or one.
 *
 * A `$each` body that itself expands to an array is FLATTENED into the output rather than nested,
 * which is what makes a `$each` inside a `$each` body work — a table's cells expand into the same
 * flat component list as its rows. (A body meant to stay an array, like a `children` list, is a
 * property value; it goes through `expandValue`, which doesn't splice.)
 */
function expandArray(items: unknown[], scope: ExpandScope): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    if (isEach(item)) {
      const list = resolvePath(item.$each, scope);
      if (!Array.isArray(list)) continue; // absent or wrong-typed list = no rows
      list.forEach((entry, index) => {
        const expanded = expandValue(item.body, loopScope(item, entry, index, scope));
        if (Array.isArray(expanded)) out.push(...expanded);
        else if (expanded !== undefined) out.push(expanded);
      });
      continue;
    }
    if (isIf(item)) {
      const branch = ifBranch(item, scope);
      if (branch !== undefined) {
        const expanded = expandValue(branch, scope);
        if (expanded !== undefined) out.push(expanded);
      }
      continue;
    }
    const expanded = expandValue(item, scope);
    if (expanded !== undefined) out.push(expanded);
  }
  return out;
}

/** Expand one node of the template tree. */
function expandValue(value: unknown, scope: ExpandScope): unknown {
  if (typeof value === "string") return substitute(value, scope);
  if (Array.isArray(value)) return expandArray(value, scope);
  if (isEach(value)) {
    // A `$each` in a PROPERTY position (e.g. `children: {$each …}`) becomes the expanded array —
    // one entry per item, no splicing, because the property's value IS the list.
    const list = resolvePath(value.$each, scope);
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) =>
      expandValue(value.body, loopScope(value, entry, index, scope)),
    );
  }
  if (isIf(value)) {
    const branch = ifBranch(value, scope);
    return branch === undefined ? undefined : expandValue(branch, scope);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const expanded = expandValue(child, scope);
      // Drop keys whose value expanded away — A2UI component schemas are strict, and an explicit
      // `undefined` prop is not the same as an absent one.
      if (expanded !== undefined) out[key] = expanded;
    }
    return out;
  }
  return value;
}

/**
 * Expand a declared template against the model's input. Pure data in, pure data out; the result still
 * has to pass `validateA2uiMessages` before it's allowed near a client.
 */
export function expandTemplate(
  template: readonly A2uiMessage[],
  scope: ExpandScope,
): A2uiMessage[] {
  return expandArray(template as unknown[], scope) as A2uiMessage[];
}

// ---------- input guard

/**
 * A shallow check of the model's `input` against the template's declared JSON Schema: required keys
 * present, and top-level types roughly right. Deliberately not a JSON Schema implementation — the
 * real authority is `validateA2uiMessages` on the expanded output, which catches anything that would
 * actually fail to render. This exists because that error arrives as "Text.text expected string" when
 * the true problem is "you forgot `question`", and the model deserves the second message.
 */
export function checkTemplateInput(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    if (typeof key === "string" && input[key] === undefined) {
      issues.push(`${key}: required`);
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || !isRecord(spec)) continue;
    const expected = typeof spec.type === "string" ? spec.type : null;
    if (!expected) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const ok =
      expected === actual ||
      (expected === "integer" && actual === "number") ||
      (expected === "object" && isRecord(value));
    if (!ok) issues.push(`${key}: expected ${expected}, got ${actual}`);
  }
  return issues;
}

// ---------- the tool

const RenderCardInput = z.object({
  template: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

/** One line per template in the tool description: what it draws and what it takes. */
function describeTemplates(templates: readonly UiTemplate[]): string {
  return templates
    .map((t) => {
      const properties = isRecord(t.input.properties) ? t.input.properties : {};
      const required = new Set(
        (Array.isArray(t.input.required) ? t.input.required : []).filter(
          (k): k is string => typeof k === "string",
        ),
      );
      const fields = Object.entries(properties)
        .map(([key, spec]) => {
          const type = isRecord(spec) && typeof spec.type === "string" ? spec.type : "any";
          return `${key}${required.has(key) ? "" : "?"}: ${type}`;
        })
        .join(", ");
      return `• ${t.id} — ${t.description}${fields ? ` Input: {${fields}}` : ""}`;
    })
    .join("\n");
}

/**
 * Build the `render_card` tool for a bot's live templates, or `null` when no plugin contributes one
 * (no template = no tool, rather than a tool that can only fail).
 *
 * The output shape is identical to `render_ui`'s (`{ok, a2ui}` / `{ok:false, errors}`) so the client
 * renders it through the same path and a rejected card comes back to the model the same way.
 */
// Annotated (rather than inferred) because the inferred `tool()` type reaches into @ai-sdk internals
// that can't be named from here; `ToolSet`'s member type is the shape the run loop actually needs.
export function buildRenderCardTool(templates: readonly UiTemplate[]): ToolSet[string] | null {
  if (templates.length === 0) return null;
  const byId = new Map(templates.map((t) => [t.id, t]));

  return tool({
    description:
      "Draw a ready-made interactive card in the chat. PREFER this over `render_ui`: pick a " +
      "template and pass its data, instead of hand-writing A2UI components. Clicks and submits come " +
      "back to you as a normal message, same as render_ui.\n\n" +
      `Templates (\`template\` must be one of these ids):\n${describeTemplates(templates)}\n\n` +
      "If no template fits what you need to show, fall back to `render_ui` and build the panel " +
      "yourself. On a bad call the tool returns {ok:false, errors:[…]} — read them and retry in the " +
      "same turn.",
    inputSchema: RenderCardInput,
    // Same discipline as render_ui: the human gets the card, the model gets a one-line ack, so a
    // drawn card costs almost nothing in later turns' context. Errors DO go back, to self-correct.
    toModelOutput: ({ output }) => {
      const out = output as { ok?: boolean; errors?: unknown } | null;
      if (out && out.ok === false) {
        return { type: "json" as const, value: { ok: false, errors: out.errors ?? [] } as never };
      }
      return { type: "json" as const, value: { ok: true, rendered: true } as never };
    },
    execute({ template, input }, { toolCallId }) {
      const found = byId.get(template);
      if (!found) {
        return {
          ok: false as const,
          errors: [
            {
              id: template,
              issues: [`template: unknown template. Available: ${[...byId.keys()].join(", ")}`],
            },
          ],
        };
      }

      const inputIssues = checkTemplateInput(found.input, input);
      if (inputIssues.length > 0) {
        return { ok: false as const, errors: [{ id: found.id, issues: inputIssues }] };
      }

      // Stable per call: a later `render_ui` delta can target this surface to update the card in
      // place, and two cards from the same template in one turn stay separate surfaces.
      const surfaceId = `${sanitizePluginKey(found.pluginKey)}-${sanitizePluginKey(found.name)}-${toolCallId}`;
      const messages = expandTemplate(found.template, { input, surfaceId });

      // The expanded card is validated exactly like a hand-written one — a template cannot produce a
      // surface `render_ui` would have refused.
      const result = validateA2uiMessages(messages);
      if (!result.ok) return { ok: false as const, errors: result.errors };
      return { ok: true as const, a2ui: messages };
    },
  });
}
