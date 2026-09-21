/**
 * The one A2UI component catalog the chat renders bot-authored panels against
 * (https://a2ui.org). A catalog is the security boundary: the agent can only reference
 * components we've pre-approved here — it can never inject markup or scripts. We use the
 * official `basicCatalog` (Text/Row/Column/List/Card/Tabs/Modal/Divider, Image/Icon/Video/
 * AudioPlayer, Button/TextField/CheckBox/ChoicePicker/Slider/DateTimeInput): Google's
 * production components, accessibility built in (keyboard, roving focus, ARIA).
 *
 * We DON'T fork these to re-skin them. The basic theme is entirely `--a2ui-*` CSS variables
 * whose defaults ship at zero specificity, so a single variable bridge in `globals.css`
 * (`.a2ui-panel`) recolors every component to our design tokens at once — same look, no forked
 * code, no lost accessibility. Should a component ever need structural changes (not just
 * color), swap just that one via `createComponentImplementation` + a `Catalog` and keep the
 * rest of `basicCatalog`.
 *
 * Kept as a single export so there's one place to evolve the catalog and one id to normalize
 * incoming `createSurface` messages against (see A2uiPanel).
 */
import { basicCatalog } from "@a2ui/react/v0_9";

export const ibotCatalog = basicCatalog;

/** The catalog id every rendered surface is pinned to (model typos are normalized to this). */
export const IBOT_CATALOG_ID = basicCatalog.id;
