/**
 * Server-side pre-flight for the `render_ui` tool's A2UI messages, mirroring EXACTLY the checks
 * the web client's `@a2ui/web_core` `MessageProcessor` runs before it will render a surface.
 *
 * Why this exists: the client validates every component in an `updateComponents` batch against the
 * basic-catalog zod schemas (`.strict()`) and, if ANY one fails, throws `A2uiValidationError` and
 * drops the WHOLE batch — so the surface never gets its components and stays stuck at
 * `[Loading root...]`. The client only `console.error`s, so the model that emitted the panel never
 * learns why. `render_ui` used to return `{ok:true}` unconditionally, hiding the failure entirely.
 *
 * We reproduce the same validation here (same `BASIC_COMPONENTS` schemas, same `formatZodIssue`
 * formatting) so a bad panel comes back to the model as `{ok:false, errors}` in the SAME turn —
 * the model reads the precise field-level issues and self-corrects, instead of the human staring at
 * a spinner. Two failure modes are caught, because both render as `[Loading root...]`:
 *   1. A component whose props violate its catalog schema (the batch-drop above).
 *   2. No component with id `"root"` — the surface's required entry node (`ROOT_COMPONENT_ID` in
 *      web_core's node-resolver); without it there is nothing to mount even if every component is
 *      individually valid.
 *
 * Validation is intentionally a mirror, not a superset: we only flag what the client would reject,
 * so a panel that passes here renders there. Partial updates that reference an already-created
 * component by id without re-stating its `component` type are left to the client (we have no prior
 * surface state), matching the client's `component || existing?.type` fallback — we validate only
 * when the type is present on the message.
 */
import { BASIC_COMPONENTS, formatZodIssue } from "@a2ui/web_core/v0_9";
import type { A2uiMessage } from "@i-bot/types";

/** name → catalog API (`{name, schema}`) for the basic catalog the client renders against. */
const COMPONENT_API_BY_NAME = new Map<
  string,
  { name: string; schema: { safeParse: (v: unknown) => SafeParseResult } }
>(
  (
    BASIC_COMPONENTS as ReadonlyArray<{
      name: string;
      schema: { safeParse: (v: unknown) => SafeParseResult };
    }>
  ).map((api) => [api.name, api]),
);

interface SafeParseResult {
  success: boolean;
  error?: { issues: unknown[] };
}

/** The literal component id the surface mounts as its tree root (web_core `ROOT_COMPONENT_ID`). */
const ROOT_COMPONENT_ID = "root";

/** One rejected component: which node, which type, and the human-readable field issues. */
export interface A2uiComponentError {
  /** The offending component's `id` (or `"(missing id)"` when the id itself is absent). */
  id: string;
  /** The component type as declared on the message, when present. */
  component?: string;
  /** Field-level messages, formatted exactly as the client logs them (`formatZodIssue`). */
  issues: string[];
}

export interface A2uiValidationResult {
  ok: boolean;
  /** Present and non-empty only when `ok` is false. */
  errors?: A2uiComponentError[];
}

interface UpdateComponentsPayload {
  components?: Array<Record<string, unknown> & { id?: unknown; component?: unknown }>;
}

/**
 * Validate `render_ui`'s A2UI messages the way the client will. Returns `{ok:true}` when the panel
 * would render, or `{ok:false, errors}` with per-component issues (plus a synthetic entry when no
 * `root` component is defined) when it would stick at `[Loading root...]`.
 */
export function validateA2uiMessages(messages: readonly A2uiMessage[]): A2uiValidationResult {
  const errors: A2uiComponentError[] = [];
  const declaredIds = new Set<string>();

  for (const message of messages) {
    const update = (message as { updateComponents?: UpdateComponentsPayload }).updateComponents;
    if (!update?.components) continue;

    for (const comp of update.components) {
      const { id, component, ...properties } = comp;
      const idStr = typeof id === "string" ? id : undefined;
      if (idStr) declaredIds.add(idStr);

      // Missing id: the client throws `Component '...' is missing an 'id'`.
      if (!idStr) {
        errors.push({
          id: "(missing id)",
          component: typeof component === "string" ? component : undefined,
          issues: ["id: every component needs a unique string `id`"],
        });
        continue;
      }

      // No type on this message → a partial update to an existing component; the client resolves
      // the type from prior state, which we don't have. Skip, matching `component || existing?.type`.
      if (typeof component !== "string") continue;

      const api = COMPONENT_API_BY_NAME.get(component);
      if (!api) {
        errors.push({
          id: idStr,
          component,
          issues: [
            `component: unknown component '${component}'. Use one of: ${[...COMPONENT_API_BY_NAME.keys()].join(", ")}`,
          ],
        });
        continue;
      }

      const result = api.schema.safeParse(properties);
      if (!result.success && result.error) {
        errors.push({
          id: idStr,
          component,
          issues: result.error.issues.map((issue) => formatZodIssue(issue as never)),
        });
      }
    }
  }

  // A NEWLY-created surface can only mount if a component with id "root" exists — missing it is the
  // other path to `[Loading root...]`. But require it ONLY when THIS batch creates the surface
  // (`createSurface`). A batch that's purely an in-place UPDATE to an existing surface
  // (updateComponents/updateDataModel referencing already-declared ids, no createSurface) has no
  // root of its own and shouldn't need one — the root was declared when the surface was first
  // created, and we have no prior state here. Enforcing root on updates would reject every valid
  // delta update (the reuse-surfaceId path). So gate on createSurface, not on "defines components".
  const createsSurface = messages.some((m) => (m as { createSurface?: unknown }).createSurface);
  if (createsSurface && !declaredIds.has(ROOT_COMPONENT_ID)) {
    errors.push({
      id: ROOT_COMPONENT_ID,
      issues: [
        'root: a new surface needs exactly one component with id "root" as its top-level container; ' +
          'give your outermost component (e.g. a Column or Card) id "root". (Updating an existing ' +
          "surface? Omit createSurface and reuse its surfaceId — then no new root is needed.)",
      ],
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
