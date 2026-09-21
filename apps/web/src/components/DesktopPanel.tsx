"use client";

import type RFB from "@novnc/novnc";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type SandboxView } from "@/lib/api";

/**
 * The live desktop pane — the "verify execution location" surface. It shows the bot's
 * isolated cloud desktop and owns the lifecycle:
 *   off → "Start desktop" → booting (~90s) → live frame → (reclaimed) → restart.
 *
 * We embed noVNC's RFB client DIRECTLY (a bare canvas mounted into our own div) instead of
 * loading the sandbox's vnc_lite.html in an iframe. The lite page draped a black letterbox and
 * its own "Connected to …" / "Send CtrlAltDel" chrome around the canvas; embedding the client
 * ourselves drops all of that — we render just the desktop, and size its frame to the exact
 * framebuffer aspect ratio so the canvas fills it edge-to-edge with no bars.
 *
 * View vs. take-control: `viewOnly` starts true (read-only) and flips live on the RFB instance —
 * no reconnect, no URL param. x11vnc has no `-viewonly`, so this client flag is the only gate.
 * Opt-in so a person and the agent don't fight over display `:0`.
 */

/**
 * Derive the websockify WebSocket URL from the persisted stream URL. `streamUrl` is the
 * https noVNC page URL (`https://<host>/vnc_lite.html?…`); websockify accepts the RFB
 * WebSocket upgrade at `/websockify` on the same host. Swap scheme → wss and path →
 * /websockify, drop the query. Returns null if the URL can't be parsed (never in practice).
 */
function deriveWsUrl(streamUrl: string): string | null {
  try {
    const u = new URL(streamUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    u.pathname = "/websockify";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Largest box of the given aspect ratio that fits inside `w`×`h`, integer px. */
function fitBox(w: number, h: number, aspect: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  if (w / h >= aspect) return { w: Math.round(h * aspect), h: Math.round(h) };
  return { w: Math.round(w), h: Math.round(w / aspect) };
}

/** True on macOS/iOS — the platforms where Cmd (Meta) must be remapped (see the effect below). */
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);
}

/**
 * Rewrite a Cmd (Meta) key event into Ctrl, in place, before noVNC sees it.
 *
 * Why this is needed: on macOS, noVNC sends Cmd as a Super/Alt keysym, so the shortcuts a mac user
 * reaches for reflexively — Cmd+C / Cmd+V / Cmd+A — do nothing on the remote Linux desktop (only
 * Ctrl+… works there). Cmd=Ctrl is the accepted convention for VNC clients on mac.
 *
 * Why BOTH `metaKey` and `code` must be rewritten, in this order:
 *  - `keyboard.js` has a macOS special case that fires as soon as `e.metaKey` is truthy: it emits a
 *    down/up pair for the key and returns early, so nothing else runs. Clearing `metaKey` first is
 *    what lets the event take the ordinary path.
 *  - `code` (not `keysym`) is the key in noVNC's `_keyDownList`, and key-up looks the entry up BY
 *    `code`. Rewriting only the keysym sends Ctrl-down but then fails that lookup on release, so the
 *    server never sees the Ctrl-up and the remote keyboard is left stuck with Ctrl held.
 *
 * Only Meta is touched. noVNC already handles the other mac quirks (semicolon layout, Alt→AltGraph,
 * the flaky Meta release, CapsLock), and re-doing that work here would double-patch them.
 */
function rewriteCmdToCtrl(e: KeyboardEvent): void {
  Object.defineProperty(e, "metaKey", { value: false, configurable: true });
  if (e.code === "MetaLeft" || e.code === "MetaRight") {
    Object.defineProperty(e, "code", { value: "ControlLeft", configurable: true });
    Object.defineProperty(e, "key", { value: "Control", configurable: true });
  }
}

export function DesktopPanel({
  botId,
  onActive,
}: {
  botId: string;
  onActive?: (active: boolean) => void;
}) {
  const [sandbox, setSandbox] = useState<SandboxView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // A start/restart that threw (network / 5xx) — distinct from a server-reported revive failure
  // (`sandbox.error`). Either one is shown so the button never fails silently.
  const [startError, setStartError] = useState<string | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Fullscreen: promote the pane to a window-filling overlay so the desktop is big enough to
  // actually work in. CSS-only (position:fixed) so the RFB host div never moves in the DOM → the
  // connection survives toggling. Entering also takes control (interactive) so it's usable at once.
  const [fullscreen, setFullscreen] = useState(false);
  // Bumped to tear down and re-create the RFB client so it re-establishes its WebSocket. The
  // client has no self-reconnect for a silently dropped socket, so we bump this on the events that
  // follow one (tab wake, network back, connect timeout) — the "auto-reconnect, don't gray out"
  // path for a live box whose preview socket died without the box itself dying (sleep, bg tab).
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const reconnect = useCallback(() => setReconnectNonce((n) => n + 1), []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The div RFB mounts its canvas into, the live RFB instance, and a ref mirror of
  // `interactive` so the connect effect can seed viewOnly without re-running on toggle.
  const screenHostRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  // Framebuffer aspect ratio (w/h). Seeded to the desktop's known 1280×800 (16:10) so the
  // frame is correctly shaped before the first connect, then refined from the live canvas.
  const [aspect, setAspect] = useState(1280 / 800);
  // The available pane area (content box), measured so we can size the framed screen to the
  // framebuffer aspect and center it — no letterbox, no CSS aspect-ratio collapse quirks.
  const [pane, setPane] = useState<{ w: number; h: number } | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const view = await api.getSandbox(botId).catch(() => null);
    setSandbox(view);
    onActive?.(view?.state === "active");
    return view;
  }, [botId, onActive]);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Poll fast (3s) while provisioning; slow (30s) while active so a reclaimed box (the
  // server flips the row to "off" on a dead-preview probe) surfaces without a manual reload.
  useEffect(() => {
    const state = sandbox?.state;
    // Poll fast while provisioning; every 10s while active so a server-detected death (the
    // dead-preview probe flips the row to `resume`) surfaces quickly and the UI reconnects
    // instead of sitting on a frozen frame.
    const interval =
      state === "create" || state === "resume" ? 3000 : state === "active" ? 10_000 : 0;
    if (interval > 0) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => void refresh(), interval);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [sandbox?.state, refresh]);

  const state = sandbox?.state;
  const provisioning = state === "create" || state === "resume";
  const active = state === "active" && Boolean(sandbox?.streamUrl);
  // `kill` means the box existed and is gone (reclaimed / stopped) — distinct from never-started.
  const reclaimed = state === "kill";
  // What to tell the user if the last lifecycle action failed: a thrown start() wins (freshest),
  // else the server's revive-failure reason. Cleared implicitly once a start succeeds.
  const notice = startError ?? sandbox?.error ?? null;

  // Elapsed timer while booting — reassures the user it's progressing, not stuck.
  useEffect(() => {
    if (!provisioning) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [provisioning]);

  // Connect (and reconnect) the RFB client. Re-runs on active flips and forced reconnects
  // (reconnectNonce); NOT on `interactive` — that flips viewOnly live in the effect below, no
  // reconnect. The client is imported lazily (SSR-safe: it touches `document` at construction).
  useEffect(() => {
    if (!active) return;
    const streamUrl = sandbox?.streamUrl;
    const host = screenHostRef.current;
    if (!streamUrl || !host) return;
    const wsUrl = deriveWsUrl(streamUrl);
    if (!wsUrl) return;

    setConnected(false);
    let disposed = false;
    let rfb: RFB | null = null;

    const onConnect = () => {
      if (disposed) return;
      setConnected(true);
      // Refine the frame's aspect from the real framebuffer so it fills edge-to-edge.
      const canvas = host.querySelector("canvas");
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        setAspect(canvas.width / canvas.height);
      }
    };
    const onDisconnect = () => {
      if (disposed) return;
      setConnected(false);
      // A live box whose socket dropped (sleep/blip) — the 12s timeout effect will remount.
    };
    // Remote → local: the desktop's clipboard changed (x11vnc `-clip` + the autocutsel bridge on
    // the box). Mirror it into the browser clipboard so a copy on the remote can be pasted here.
    // This event only fires while a session is live and never in viewOnly (noVNC returns early),
    // so no extra guarding is needed. writeText needs the document focused and can reject
    // (permissions, unfocused tab) — that's a soft failure by design: the remote still has the
    // text, and nothing in the desktop UI depends on this landing. Never surface an error here.
    const onClipboard = (ev: Event) => {
      const text = (ev as CustomEvent<{ text?: string }>).detail?.text;
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    };

    void (async () => {
      const { default: RFBClass } = await import("@novnc/novnc");
      if (disposed || !screenHostRef.current) return;
      // Fresh mount point each connect, in case a prior teardown left anything behind.
      host.replaceChildren();
      rfb = new RFBClass(host, wsUrl, { shared: true });
      rfb.viewOnly = !interactiveRef.current;
      rfb.scaleViewport = true; // fit the framebuffer into our sized frame (aspect preserved)
      rfb.clipViewport = false;
      rfb.resizeSession = false; // Xvfb is fixed-size (no RANDR) — never ask the server to resize
      rfb.background = "transparent"; // our frame already matches the aspect → no visible bars
      rfb.addEventListener("connect", onConnect);
      rfb.addEventListener("disconnect", onDisconnect);
      rfb.addEventListener("clipboard", onClipboard);
      rfbRef.current = rfb;
    })();

    return () => {
      disposed = true;
      if (rfb) {
        rfb.removeEventListener("connect", onConnect);
        rfb.removeEventListener("disconnect", onDisconnect);
        rfb.removeEventListener("clipboard", onClipboard);
        try {
          rfb.disconnect();
        } catch {
          // already torn down
        }
      }
      rfbRef.current = null;
    };
  }, [active, sandbox?.streamUrl, reconnectNonce]);

  // Flip view/control live on the running client — no reconnect. viewOnly=true is read-only.
  // On taking control, also pull keyboard focus onto the RFB canvas: without focus the browser
  // eats shortcuts like Ctrl+A / Ctrl+C (they select/copy THIS page instead of reaching the
  // remote), so "select all" etc. appear to do nothing on the desktop. rfb.focus() routes the
  // whole keyboard to the framebuffer. Deferred a tick so it runs after the fullscreen relayout.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !interactive;
    if (interactive && connected) {
      const id = setTimeout(() => {
        try {
          rfb.focus();
        } catch {
          // client torn down between the flip and this tick — nothing to focus
        }
      }, 0);
      return () => clearTimeout(id);
    }
    return;
  }, [interactive, connected]);

  // mac only: make the remote desktop honour Cmd+… as Ctrl+… while a human holds control.
  // Bound on OUR host div in the CAPTURE phase, so it runs before the listener noVNC put on the
  // canvas it mounts inside — the rewritten event then flows down to noVNC unchanged. Never
  // touches noVNC internals, and is inert when not in control (nothing should be remapped while
  // the pane is a read-only preview).
  useEffect(() => {
    const host = screenHostRef.current;
    if (!interactive || !host || !isApplePlatform()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey) rewriteCmdToCtrl(e);
    };
    // capture on both, so a Cmd-down and its release are rewritten symmetrically (see the
    // stuck-Ctrl note in rewriteCmdToCtrl).
    host.addEventListener("keydown", onKey, { capture: true });
    host.addEventListener("keyup", onKey, { capture: true });
    return () => {
      host.removeEventListener("keydown", onKey, { capture: true });
      host.removeEventListener("keyup", onKey, { capture: true });
    };
  }, [interactive, connected]);

  // local → remote: noVNC has no key binding that pushes the browser clipboard to the desktop
  // (`clipboardPasteFrom` is an explicit call, and the RFB protocol carries no paste-on-keypress),
  // so a plain Ctrl+V / Cmd+V does nothing on the remote. Intercept it and push the text across,
  // then swallow the event so the remote doesn't ALSO see a bare Ctrl+V. readText needs permission
  // and a focused document and may reject — swallow that too: the user can still paste on the box
  // with the remote's own shortcut, and a thrown promise here would be an unhandled rejection.
  // Bound in capture on our host div for the same reason as the Cmd remap above. Not applied in
  // viewOnly: noVNC's clipboardPasteFrom is a no-op there by design, and this pane is a read-only
  // preview until someone takes control.
  useEffect(() => {
    const host = screenHostRef.current;
    if (!interactive || !host) return;
    const onPaste = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "v" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const rfb = rfbRef.current;
      if (!rfb) return;
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) rfb.clipboardPasteFrom(text);
          return text;
        })
        .catch(() => "");
    };
    host.addEventListener("keydown", onPaste, { capture: true });
    return () => host.removeEventListener("keydown", onPaste, { capture: true });
  }, [interactive, connected]);

  // Measure the pane content box so we can size the framed screen to the framebuffer aspect
  // ratio (largest fitting box, centered). useLayoutEffect + a ResizeObserver keeps it exact
  // through split/fullscreen resizes without a first-paint collapse.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setPane({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  // Auto-reconnect a live box's preview when the socket likely dropped without the box dying:
  // waking a backgrounded tab and coming back online both leave the WebSocket half-dead with no
  // self-reconnect. Bumping reconnectNonce re-creates the RFB client. Only while active.
  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconnect);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconnect);
    };
  }, [active, reconnect]);

  // Connect-timeout: if the RFB client hasn't fired "connect" within 12s (initial attempt or a
  // reconnect), bump the nonce to tear down and re-create it so a stalled WebSocket handshake
  // retries instead of hanging on the spinner. Cleared as soon as the connect event sets `connected`.
  useEffect(() => {
    if (!active || connected) return;
    const id = setTimeout(() => reconnect(), 12_000);
    return () => clearTimeout(id);
  }, [active, connected, reconnectNonce, reconnect]);

  // Control and the maximized view are coupled by one invariant: `interactive ⟹ fullscreen`.
  // A human taking control maximizes the pane — it gives room to work AND the window-filling
  // overlay physically covers the chat composer, so you can't fire agent instructions into the
  // conversation while hand-driving the box. Releasing control drops back to the split. A
  // read-only "watch big" fullscreen (no control) is still allowed for a large passive view.
  const takeControl = useCallback(() => {
    setInteractive(true);
    setFullscreen(true);
  }, []);
  const releaseControl = useCallback(() => {
    setInteractive(false);
    setFullscreen(false);
  }, []);
  // ESC leaves the maximized view. Under the `interactive ⟹ fullscreen` invariant, fullscreen only
  // ever exists WITH control (takeControl sets both), so exiting it also hands the desktop back —
  // identical to releaseControl, kept as its own name for the keydown handler's intent.
  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    setInteractive(false);
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, exitFullscreen]);
  // Leaving fullscreen never remounts the RFB client (the host div is the same DOM node, only the
  // outer container's CSS changes), so the live connection + `connected` stay valid. Nothing to do.

  // Tell the server when a human holds the desktop, so the agent's desktop_action is refused
  // while we're in control (no fighting over `:0`). Only meaningful while the box is active;
  // release on toggle-off, going inactive, or unmount (navigating away mid-control).
  useEffect(() => {
    const held = active && interactive;
    void api.setDesktopControl(botId, held).catch(() => {});
    return () => {
      if (held) void api.setDesktopControl(botId, false).catch(() => {});
    };
  }, [botId, active, interactive]);

  async function start() {
    setBusy(true);
    setStartError(null);
    try {
      const view = await api.provisionSandbox(botId);
      setSandbox(view);
    } catch (err) {
      // Don't leave the click silent — surface why it failed and let the user retry.
      setStartError(err instanceof Error ? err.message : "启动失败,请重试。");
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = active
    ? interactive
      ? "You're in control"
      : "Live · watching"
    : provisioning
      ? "Starting…"
      : reclaimed
        ? "Session ended"
        : "Off";
  const statusTone = active ? "dot-ok dot-live" : provisioning ? "dot-warn dot-live" : "dot-muted";

  // When live, the framed screen is a framebuffer-aspect box (the largest that fits the pane),
  // centered — so the desktop shows at its own aspect with no letterbox. Non-live states fill
  // the pane so their centered card has room.
  const screen = active && pane ? fitBox(pane.w, pane.h, aspect) : null;

  return (
    <div
      style={
        fullscreen
          ? {
              // fill the whole window, above the rail + chat, without disturbing the RFB host div
              position: "fixed",
              inset: 0,
              zIndex: 50,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              background: "var(--surface)",
            }
          : { display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }
      }
    >
      {/* pane body — a matte inset that centers the framed screen (no header row; the status +
          controls float in the screen's top-right corner while it's live) */}
      <div
        ref={paneRef}
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--bg-subtle)",
          padding: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "relative",
            // Live: a framebuffer-aspect box (no letterbox). Otherwise fill the pane.
            width: screen ? screen.w : "100%",
            height: screen ? screen.h : "100%",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            boxShadow: "var(--shadow-sm)",
            overflow: "hidden",
          }}
        >
          {active ? (
            <>
              {/* RFB mounts its canvas here; it fills the box since the box matches the aspect */}
              <div ref={screenHostRef} style={{ width: "100%", height: "100%" }} />

              {/* Floating status + control. CRITICAL: while interactive, this overlay must NOT
                  steal pointer events from the live desktop — an opaque div over the framebuffer
                  eats the hover/click for any remote popup/dialog/dropdown rendered beneath it
                  (the "popup under the bar won't respond in take-control" bug). So the wrapper is
                  `pointerEvents:none` and only the actual controls re-enable it — the empty space
                  and the gap between them pass clicks straight through to noVNC.

                  Parked at bottom-CENTER in both states. It used to sit bottom-RIGHT while
                  interactive, which covered the tint2 panel's clock in the screen's bottom-right
                  corner — the one thing on the desktop that's always there to be covered. Center
                  is free: the remote taskbar's middle is empty and dialogs open centered higher up.
                  Only the button footprint blocks anything, same as before. */}
              <div
                style={{
                  position: "absolute",
                  bottom: 12,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  pointerEvents: "none", // pass hover/clicks through the wrapper to the desktop
                }}
              >
                {!interactive && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 10px",
                      borderRadius: 999,
                      background: "color-mix(in srgb, var(--surface) 88%, transparent)",
                      border: "1px solid var(--border)",
                      fontSize: 11.5,
                      color: "var(--ink-secondary)",
                      backdropFilter: "saturate(140%) blur(6px)",
                      pointerEvents: "auto",
                    }}
                  >
                    <span className={`dot ${statusTone}`} />
                    {statusLabel}
                  </span>
                )}
                <button
                  // Release must stay readable floating over the live desktop, so it's a solid
                  // (opaque) button, never `btn-ghost` (transparent → invisible on a busy frame).
                  // Take-control is the accent primary; release is the neutral solid. Only the
                  // button itself re-enables pointer events (its ~1 button footprint is the sole
                  // spot that blocks the desktop, now tucked in the corner while interactive).
                  className={`btn btn-sm ${interactive ? "" : "btn-primary"}`}
                  style={{ pointerEvents: "auto" }}
                  onClick={interactive ? releaseControl : takeControl}
                  title={
                    interactive
                      ? "Hand the desktop back to the bot (Esc) and return to the split view"
                      : "Take mouse + keyboard control — the desktop maximizes and the bot's input is paused"
                  }
                >
                  {interactive ? "Release control (Esc)" : "Take control"}
                </button>
              </div>

              {/* connecting overlay until the noVNC page loads */}
              {!connected && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    background: "var(--surface)",
                  }}
                >
                  <span className="spinner" style={{ width: 18, height: 18 }} />
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Connecting to the desktop…
                  </span>
                </div>
              )}
            </>
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 16,
                padding: 28,
                textAlign: "center",
              }}
            >
              {provisioning ? (
                <BootingState elapsed={elapsed} />
              ) : reclaimed ? (
                <>
                  <ScreenGlyph tone="warn" />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 560 }}>Session ended</div>
                    <p
                      className="muted"
                      style={{ fontSize: 12.5, marginTop: 5, maxWidth: 320, lineHeight: 1.55 }}
                    >
                      The cloud desktop was reclaimed after inactivity. Restart it to pick up where
                      you left off — a fresh isolated box, about 90 seconds.
                    </p>
                  </div>
                  {notice && <LifecycleNotice text={notice} />}
                  <button className="btn btn-primary" onClick={start} disabled={busy}>
                    {busy ? <span className="spinner" /> : "Restart desktop"}
                  </button>
                </>
              ) : (
                <>
                  <ScreenGlyph />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 560 }}>Desktop is off</div>
                    <p
                      className="muted"
                      style={{ fontSize: 12.5, marginTop: 5, maxWidth: 320, lineHeight: 1.55 }}
                    >
                      Start the bot&apos;s private Linux desktop to watch it work in real time — and
                      take control whenever you want to step in.
                    </p>
                  </div>
                  {notice && <LifecycleNotice text={notice} />}
                  <button className="btn btn-primary" onClick={start} disabled={busy}>
                    {busy ? <span className="spinner" /> : "Start desktop"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A small inline warning shown when a start/restart failed, so the button never fails silently. */
function LifecycleNotice({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        maxWidth: 340,
        padding: "7px 11px",
        borderRadius: "var(--radius-sm)",
        background: "color-mix(in srgb, var(--danger) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
        color: "var(--danger)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}

function BootingState({ elapsed }: { elapsed: number }) {
  // desktop stack (openbox/tint2/pcmanfm + chromium) apt-installs in ~2 min cold
  const pct = Math.min(95, Math.round((elapsed / 150) * 100));
  return (
    <>
      <span className="spinner" style={{ width: 22, height: 22 }} />
      <div>
        <div style={{ fontSize: 14, fontWeight: 560 }}>Booting the desktop</div>
        <p
          className="muted"
          style={{ fontSize: 12.5, marginTop: 5, maxWidth: 320, lineHeight: 1.55 }}
        >
          Provisioning an isolated Linux box: a desktop (window manager, taskbar, file manager),
          Chrome, and a live preview bridge. This takes a couple of minutes.
        </p>
      </div>
      {/* thin determinate-ish progress — hairline track, accent fill */}
      <div style={{ width: 220, maxWidth: "70%" }}>
        <div
          style={{
            height: 3,
            borderRadius: 2,
            background: "var(--border)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "var(--accent)",
              transition: "width 1s linear",
            }}
          />
        </div>
        <div
          className="muted"
          style={{ fontSize: 11, marginTop: 6, fontVariantNumeric: "tabular-nums" }}
        >
          {formatElapsed(elapsed)} elapsed
        </div>
      </div>
    </>
  );
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function ScreenGlyph({ tone }: { tone?: "warn" }) {
  // A bare lineart mark, no tile. The filled rounded-square-behind-an-icon is the tell-tale
  // "AI empty state" and also breaks this project's rules (no pure-color fills, no large radii —
  // depth comes from the panel's own hairline border). Reclaim-after-idle is routine, not a fault,
  // so the ended state gets a warm low-sat amber, never an alarming red box; the off state stays a
  // quiet muted grey. The one accent color in this view lives on the action button, not the icon.
  const color = tone === "warn" ? "var(--warn)" : "var(--ink-muted)";
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3.5" width="20" height="13" rx="2.5" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  );
}
