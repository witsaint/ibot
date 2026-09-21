/**
 * In-process per-conversation event bus. The chat UI used to poll `/jobs/active` every 2.5s;
 * now it holds a Server-Sent-Events stream (`GET /conversations/:id/events`) and this bus pushes
 * lifecycle events to it as they happen: a task started/finished, the run state changed, or new
 * messages are ready to pull.
 *
 * Deliberately tiny and best-effort. It carries NOTIFICATIONS, never authoritative state — the DB
 * remains the source of truth (the client re-reads messages on `message.ready`). A dropped event
 * (no listener attached, a slow client) is therefore harmless: the next poll-on-reconnect or the
 * `run.state` snapshot sent on connect re-syncs the UI. `publish` never throws into a caller (a
 * failing listener must not break an agent run), so callers fire events without try/catch.
 *
 * Single process only. A multi-instance deployment would need a shared broker (Redis pub/sub); the
 * SSE route and this interface are the seam where that swap would happen.
 */
import type { ConversationEvent } from "@i-bot/types";

type Listener = (event: ConversationEvent) => void;

export class ConversationEventBus {
  /** conversationId → its live SSE listeners. */
  #listeners = new Map<string, Set<Listener>>();

  /**
   * Subscribe a listener to a conversation's events. Returns an unsubscribe function the SSE
   * route MUST call when the client disconnects, or listeners leak. Idempotent unsubscribe.
   */
  subscribe(conversationId: string, listener: Listener): () => void {
    const set = this.#listeners.get(conversationId);
    if (set) set.add(listener);
    else this.#listeners.set(conversationId, new Set([listener]));

    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = this.#listeners.get(conversationId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.#listeners.delete(conversationId);
    };
  }

  /** Push an event to every listener on a conversation. Best-effort — a throwing listener is
   *  isolated so one bad stream can't break a run or the other listeners. */
  publish(conversationId: string, event: ConversationEvent): void {
    const set = this.#listeners.get(conversationId);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        /* a listener must never break the publisher */
      }
    }
  }

  /** How many listeners a conversation has (for a fast "anyone watching?" check / tests). */
  listenerCount(conversationId: string): number {
    return this.#listeners.get(conversationId)?.size ?? 0;
  }
}
