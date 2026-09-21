"use client";

import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { A2uiSurface } from "@a2ui/react/v0_9";
import type { A2uiMessage } from "@i-bot/types";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ibotCatalog, IBOT_CATALOG_ID } from "@/components/a2ui-catalog";

/**
 * Build a `MessageProcessor` bound to our single catalog. Factored out so the processor's exact
 * generic type (`MessageProcessor<T>` where `T` is `ibotCatalog`'s component-api type) is inferred
 * once and reused everywhere via `IbotProcessor`, instead of being spelled out by hand.
 */
function makeProcessor(handler: (action: A2uiAction) => void) {
  return new MessageProcessor([ibotCatalog], (action) => handler(action as unknown as A2uiAction));
}
type IbotProcessor = ReturnType<typeof makeProcessor>;

/** The action a user fired inside a rendered panel, forwarded to the agent. */
export interface A2uiAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  context: Record<string, unknown>;
}

/**
 * The per-conversation A2UI runtime: ONE `MessageProcessor` shared by every panel in the thread,
 * plus a set of the render_ui tool-call ids already fed into it.
 *
 * Why shared (not one processor per panel, as before): an A2UI surface has a single identity across
 * turns. To UPDATE a card in place, the model re-emits render_ui with the SAME surfaceId and only a
 * delta (updateComponents/updateDataModel, no createSurface). A per-panel processor can't do that —
 * the delta arrives with no prior surface state and `processUpdateComponentsMessage` throws
 * "Surface not found". With one shared processor, the delta mutates the SAME surface object the
 * creating panel is rendering, and `A2uiSurface`'s own reactive subscription re-renders it in place.
 *
 * The `fed` set makes feeding idempotent: `processCreateSurfaceMessage` throws "already exists" if a
 * surface is created twice, so each tool part is processed at most once per processor lifetime
 * (guards React StrictMode's double-invoked effects and re-renders). The processor's global action
 * handler reads a ref so it always calls the latest `onAction` without being rebuilt.
 */
interface A2uiRuntime {
  processor: IbotProcessor;
  fed: Set<string>;
}
const A2uiRuntimeContext = createContext<A2uiRuntime | null>(null);

/**
 * Provides the shared per-conversation A2UI runtime to every `A2uiPanel` beneath it. Mount it once
 * around the message list. `onAction` is wired into the processor at construction via a ref, so a
 * changing handler identity never rebuilds the processor (which would drop live surface state).
 */
export function A2uiRuntimeProvider({
  onAction,
  children,
}: {
  onAction?: (action: A2uiAction) => void;
  children: React.ReactNode;
}) {
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const [runtime] = useState<A2uiRuntime>(() => ({
    processor: makeProcessor((action) => onActionRef.current?.(action)),
    fed: new Set<string>(),
  }));
  return <A2uiRuntimeContext.Provider value={runtime}>{children}</A2uiRuntimeContext.Provider>;
}

/**
 * Renders one bot-authored A2UI panel — the output of a single `render_ui` tool call.
 *
 * The panel feeds its messages into the shared conversation processor (once, keyed by `partId`),
 * then renders ONLY the surfaces it itself created (its `createSurface` messages). A delta-only
 * part — a render_ui that reuses an existing surfaceId to update the card, with no createSurface —
 * owns no surface, so it renders nothing visible: its feed mutates the already-rendered surface and
 * the panel that created it updates in place.
 *
 * The agent can only instantiate pre-approved components (the fixed `ibotCatalog`), never raw
 * markup; `catalogId` on incoming `createSurface` messages is normalized to our catalog id so a
 * model typo can't throw "Catalog not found". Without a provider it falls back to a private
 * processor (self-contained rendering, no cross-part updates) so the component stays usable.
 */
export function A2uiPanel({
  messages,
  partId,
  onAction,
}: {
  messages: A2uiMessage[];
  /** Stable id of the render_ui tool call (its `toolCallId`) — the dedup key for feeding. */
  partId?: string;
  /** Only used in the no-provider fallback; the provider's handler wins when present. */
  onAction?: (action: A2uiAction) => void;
}) {
  const shared = useContext(A2uiRuntimeContext);
  // Fallback for a panel rendered with no provider (tests, standalone use): a private processor
  // wired to this panel's own onAction. No cross-part in-place updates in this mode.
  const fallbackOnActionRef = useRef(onAction);
  fallbackOnActionRef.current = onAction;
  const [fallback] = useState<A2uiRuntime | null>(() =>
    shared
      ? null
      : {
          processor: makeProcessor((action) => fallbackOnActionRef.current?.(action)),
          fed: new Set<string>(),
        },
  );
  const { processor, fed } = shared ?? fallback!;

  // The surfaces THIS part owns = the ones it creates. Delta-only parts own none.
  const ownedIds = messages
    .map((m) => (m as { createSurface?: { surfaceId?: string } }).createSurface?.surfaceId)
    .filter((id): id is string => typeof id === "string");

  // A stable-per-render dedup key: the render_ui tool-call id when present, else fall back to the
  // owned surface ids (also stable for a given part). Guards double-feeding one part.
  const feedKey = partId ?? `surf:${ownedIds.join(",")}`;

  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!fed.has(feedKey)) {
      fed.add(feedKey);
      try {
        // Our `A2uiMessage` is the loose transport/storage contract; `web_core` owns the strict
        // v0.9 union and validates deeply at runtime. Cross that boundary with one cast.
        type ProcessArg = Parameters<typeof processor.processMessages>[0];
        processor.processMessages(normalizeCatalogIds(messages) as unknown as ProcessArg);
      } catch (err) {
        console.error("[a2ui] failed to process panel messages", err);
      }
    }
    // Re-render when surfaces come and go (this part's own surface appearing after the feed, or a
    // deleteSurface removing it) so the rendered set tracks the shared model.
    const bump = () => forceRender((n) => n + 1);
    const createdSub = processor.onSurfaceCreated(bump);
    const deletedSub = processor.onSurfaceDeleted(bump);
    bump();
    return () => {
      createdSub.unsubscribe();
      deletedSub.unsubscribe();
    };
    // feedKey identifies this part; messages is its stable snapshot; processor/fed are stable.
  }, [processor, fed, feedKey, messages]);

  const surfaces = ownedIds
    .map((id) => processor.model.surfacesMap.get(id))
    .filter((s): s is NonNullable<typeof s> => s != null);

  if (surfaces.length === 0) return null;

  return (
    <div className="a2ui-panel">
      {surfaces.map((surface) => (
        <A2uiSurface key={surface.id} surface={surface} />
      ))}
    </div>
  );
}

/**
 * Pin every `createSurface.catalogId` to our registered catalog id. The agent's messages are
 * untrusted input; a wrong/absent id would otherwise throw in the processor. Returns a new
 * array — never mutates the stored part.
 */
function normalizeCatalogIds(messages: A2uiMessage[]): A2uiMessage[] {
  return messages.map((m) => {
    const cs = (m as { createSurface?: { catalogId?: string } }).createSurface;
    if (!cs) return m;
    return { ...m, createSurface: { ...cs, catalogId: IBOT_CATALOG_ID } };
  });
}
