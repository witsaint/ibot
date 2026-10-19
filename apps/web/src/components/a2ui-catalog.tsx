"use client";

/**
 * The one A2UI component catalog the chat renders bot-authored panels against
 * (https://a2ui.org). A catalog is the security boundary: the agent can only reference
 * components we've pre-approved here — it can never inject markup or scripts. We use the
 * official `basicCatalog` (Text/Row/Column/List/Card/Tabs/Modal/Divider, Image/Icon/Video/
 * AudioPlayer, Button/TextField/CheckBox/ChoicePicker/Slider/DateTimeInput): Google's
 * production components, accessibility built in (keyboard, roving focus, ARIA).
 *
 * We DON'T fork these to re-skin them: they're restyled by element under `.a2ui-panel` in
 * `globals.css` (see the note there on why the package's own CSS-module class maps are empty in
 * 0.11.1). ONE component is swapped, for a reason CSS can't fix: the stock `Button` reads its
 * variant into class names from that empty map, so `default` / `primary` / `borderless` all render
 * as an identical bare `<button>` — the DOM carries no trace of the variant to style against. Our
 * `Button` is the same render (same `ButtonApi` schema, same `action`/`isValid` wiring, same
 * `buildChild` for the label) plus a `data-variant` attribute. Everything else is `basicCatalog`.
 *
 * Kept as a single export so there's one place to evolve the catalog and one id to normalize
 * incoming `createSurface` messages against (see A2uiPanel).
 */
import { Catalog } from "@a2ui/web_core/v0_9";
import { BASIC_FUNCTIONS, ButtonApi } from "@a2ui/web_core/v0_9/basic_catalog";
import { basicCatalog, createComponentImplementation } from "@a2ui/react/v0_9";

/**
 * `Button` with its variant exposed as `data-variant` so the stylesheet can tell them apart.
 * Mirrors the stock implementation 1:1 otherwise — `props.action` is already the bound click
 * handler the runtime built from the component's `action`, and `isValid === false` (a form the
 * button submits has invalid fields) disables it.
 */
const Button = createComponentImplementation(ButtonApi, ({ props, buildChild }) => (
  <button
    type="button"
    data-variant={props.variant ?? "default"}
    onClick={props.action}
    disabled={props.isValid === false}
  >
    {props.child ? buildChild(props.child) : null}
  </button>
));

/** basicCatalog with our Button in the stock one's slot; order preserved. */
export const ibotCatalog = new Catalog(
  basicCatalog.id,
  [...basicCatalog.components.values()].map((c) => (c.name === "Button" ? Button : c)),
  BASIC_FUNCTIONS,
);

/** The catalog id every rendered surface is pinned to (model typos are normalized to this). */
export const IBOT_CATALOG_ID = basicCatalog.id;
