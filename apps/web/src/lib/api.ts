/**
 * Typed client for the i-bot API. Every call is credentialed (`include`) so the
 * better-auth session cookie rides along. The browser sends `Origin` automatically,
 * satisfying better-auth's CSRF check. Errors throw `ApiError` with the status so the
 * UI can branch (401 → login, 409 → sandbox not ready, 503 → model unconfigured).
 */
import type {
  Automation,
  AutomationDefinition,
  AutomationPatch,
  AutomationRun,
  AutomationKey,
  AutomationAttention,
  AgentJob,
  Bot,
  Conversation,
  ConversationEvent,
  Message,
  ModelCredentialsView,
  ModelInfo,
  Skill,
  SkillListItem,
  SkillDraft,
} from "@i-bot/types";
import { redirectToSignIn } from "./session";

export type { ConversationEvent };

/** A snapshot of what's live on a bot right now (mirrors the SSE `run.state` event payload). */
export interface RunStateView {
  /** a foreground voice (user chat turn or proactive relay turn) is streaming */
  foreground: boolean;
  /** how many detached tasks (background jobs + spawned subagents) are running */
  taskCount: number;
  /** who holds the exclusive desktop/GUI lease */
  gui: "free" | "agent" | "human";
  /** how many runs are waiting for the GUI lease */
  queueDepth: number;
  /** the bot is paused waiting for the human (a run called `request_handoff`) */
  awaitingHuman: boolean;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Shared by JSON requests and the chat transport. Provider/login errors must not sign us out. */
export const sessionFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status === 401) {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    if (body?.error === "unauthenticated") redirectToSignIn();
  }
  return res;
};

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await sessionFetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      msg = body.message ?? body.error ?? msg;
      // Zod validation errors carry `issues` — surface the first field + reason so the
      // user sees "baseUrl: Invalid URL", not a bare "invalid body".
      const issue = Array.isArray(body.issues) ? body.issues[0] : null;
      if (issue?.message) {
        const field = Array.isArray(issue.path) ? issue.path.join(".") : "";
        msg = field ? `${field}: ${issue.message}` : issue.message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------- shape helpers ----------
export interface SandboxView {
  id: string;
  botId: string;
  state: "create" | "active" | "idle" | "pause" | "resume" | "kill";
  streamUrl: string | null;
  screen: { width: number; height: number };
  live: boolean;
  /** why the last start/restart/revive failed, if it did — shown in the panel; null otherwise */
  error: string | null;
}

// ---------- auth ----------
export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export const api = {
  automationAttention: (botId: string) =>
    req<AutomationAttention>(`/api/automations/bots/${botId}/attention`),
  listAutomations: (botId: string) => req<Automation[]>(`/api/automations/bots/${botId}`),
  createAutomation: (botId: string, data: AutomationDefinition) =>
    req<Automation>(`/api/automations/bots/${botId}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAutomation: (id: string, data: AutomationPatch) =>
    req<Automation>(`/api/automations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteAutomation: (id: string) => req<void>(`/api/automations/${id}`, { method: "DELETE" }),
  automationKey: (id: string, kind: "webhook" | "callback") =>
    req<AutomationKey>(`/api/automations/${id}/keys/${kind}`, { method: "POST" }),
  automationRuns: (id: string) => req<AutomationRun[]>(`/api/automations/${id}/runs`),
  testAutomation: (id: string) =>
    req<{ runId: string; status: string }>(`/api/automations/${id}/test`, { method: "POST" }),
  automationRunAction: (
    id: string,
    runId: string,
    action: "cancel" | "resume" | "read",
    message?: string,
  ) =>
    req<void>(`/api/automations/${id}/runs/${runId}/${action}`, {
      method: "POST",
      body: message ? JSON.stringify({ message }) : undefined,
    }),

  base: API_URL,

  async signUp(email: string, password: string, name: string): Promise<void> {
    await req("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    });
  },

  async signIn(email: string, password: string): Promise<void> {
    await req("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  async signOut(): Promise<void> {
    // better-auth's sign-out rejects a bodyless POST (415 without a content-type; 400 with the
    // json content-type `req` always sends but an empty body). Send `{}` so the body parses and
    // the session cookie is actually cleared — without it sign-out 400s and "you can't log out".
    await req("/api/auth/sign-out", { method: "POST", body: "{}" });
  },

  async me(): Promise<{ userId: string; sandboxPublicDefault: boolean }> {
    return req("/api/me");
  },

  // ---------- bots ----------
  async listBots(): Promise<Bot[]> {
    return (await req<{ bots: Bot[] }>("/api/bots")).bots;
  },
  async createBot(input: {
    name: string;
    description?: string;
    systemPrompt?: string;
    model?: string;
    /** JSON-encoded AvatarConfig (see lib/avatar) — the bot's picked portrait. */
    avatar?: string;
    /** sandbox egress: true = public (clean IP), false = internal, null/omit = inherit fleet default. */
    sandboxPublic?: boolean | null;
  }): Promise<Bot> {
    return (await req<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify(input) }))
      .bot;
  },
  async getBot(botId: string): Promise<{ bot: Bot; sandbox: SandboxView | null }> {
    return req(`/api/bots/${botId}`);
  },
  async updateBot(botId: string, patch: Partial<Bot>): Promise<Bot> {
    return (
      await req<{ bot: Bot }>(`/api/bots/${botId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })
    ).bot;
  },
  async deleteBot(botId: string): Promise<void> {
    await req(`/api/bots/${botId}`, { method: "DELETE" });
  },
  /**
   * Persist a new left-rail order. `ids` is the full list of the caller's bot ids in the
   * desired order; the server validates ownership of every id and writes each bot's sortOrder
   * to its index. Pinned bots still sort above unpinned ones — this sets the order WITHIN a tier.
   */
  async reorderBots(ids: string[]): Promise<void> {
    await req("/api/bots/reorder", { method: "PATCH", body: JSON.stringify({ ids }) });
  },

  // ---------- sandbox lifecycle ----------
  async provisionSandbox(botId: string): Promise<SandboxView> {
    return (await req<{ sandbox: SandboxView }>(`/api/bots/${botId}/sandbox`, { method: "POST" }))
      .sandbox;
  },
  async getSandbox(botId: string): Promise<SandboxView | null> {
    return (await req<{ sandbox: SandboxView | null }>(`/api/bots/${botId}/sandbox`)).sandbox;
  },
  async destroySandbox(botId: string): Promise<void> {
    await req(`/api/bots/${botId}/sandbox`, { method: "DELETE" });
  },
  /**
   * Tell the server a human is taking (or releasing) control of the desktop. While held,
   * the agent's desktop_action is refused so the human and the bot don't drive `:0` at once.
   */
  async setDesktopControl(botId: string, held: boolean): Promise<void> {
    await req(`/api/bots/${botId}/sandbox/control`, {
      method: "PUT",
      body: JSON.stringify({ held }),
    });
  },

  // ---------- conversations ----------
  async listConversations(botId: string): Promise<Conversation[]> {
    return (await req<{ conversations: Conversation[] }>(`/api/chat/bots/${botId}/conversations`))
      .conversations;
  },
  async createConversation(botId: string, title?: string): Promise<Conversation> {
    return (
      await req<{ conversation: Conversation }>(`/api/chat/bots/${botId}/conversations`, {
        method: "POST",
        body: JSON.stringify({ title }),
      })
    ).conversation;
  },
  async listMessages(conversationId: string): Promise<Message[]> {
    return (
      await req<{ messages: Message[] }>(`/api/chat/conversations/${conversationId}/messages`)
    ).messages;
  },

  // ---------- skills ("record → experience") ----------
  /** Distill a finished conversation into a reviewable skill draft (no write). */
  async analyzeSkill(conversationId: string): Promise<SkillDraft> {
    return (
      await req<{ draft: SkillDraft }>(`/api/skills/analyze`, {
        method: "POST",
        body: JSON.stringify({ conversationId }),
      })
    ).draft;
  },
  // ---------- human-session recording → skill ----------
  /** Drive the on-box recorder while a person holds the desktop. */
  async recording(
    botId: string,
    action: "start" | "stop" | "status" | "discard",
  ): Promise<{ recording: boolean; frames: number }> {
    return req(`/api/skills/recording/${botId}/${action}`, { method: "POST", body: "{}" });
  },
  /** Stop (if needed), pull the frames back and distill them into a reviewable draft. */
  async analyzeRecording(
    botId: string,
  ): Promise<{ draft: SkillDraft; frames: number; durationMs: number }> {
    return req(`/api/skills/recording/${botId}/analyze`, { method: "POST", body: "{}" });
  },
  /** Publish a reviewed draft as a bot-scoped skill. */
  async saveSkill(botId: string, draft: SkillDraft): Promise<Skill> {
    return (
      await req<{ skill: Skill }>(`/api/skills`, {
        method: "POST",
        body: JSON.stringify({ botId, ...draft }),
      })
    ).skill;
  },
  async listSkills(botId: string): Promise<SkillListItem[]> {
    return (await req<{ skills: SkillListItem[] }>(`/api/skills?botId=${botId}`)).skills;
  },
  async deleteSkill(skillId: string): Promise<void> {
    await req(`/api/skills/${skillId}`, { method: "DELETE" });
  },

  /** The chat stream endpoint — used by useChat's transport, not called directly. */
  chatEndpoint(conversationId: string): string {
    return `${API_URL}/api/chat/conversations/${conversationId}/messages`;
  },

  /**
   * The live-events SSE endpoint — opened with `new EventSource(url, { withCredentials: true })`,
   * not called directly. Pushes `ConversationEvent`s (task lifecycle + run-state snapshots),
   * replacing the old 2.5s job poll.
   */
  eventsEndpoint(conversationId: string): string {
    return `${API_URL}/api/chat/conversations/${conversationId}/events`;
  },

  // ---------- background jobs (human-initiated, run detached, UI polls) ----------
  /** Kick off a background agent turn. Returns the job id; the turn runs detached. */
  async startBackgroundJob(
    conversationId: string,
    parts: Message["parts"],
  ): Promise<{ jobId: string; status: AgentJob["status"] }> {
    return req(`/api/chat/conversations/${conversationId}/jobs`, {
      method: "POST",
      body: JSON.stringify({ parts }),
    });
  },
  /**
   * Read the latest task row for a conversation + a snapshot of what's live on the bot. The SSE
   * stream is the primary signal now; this is the reconnect/error fallback so a settle that
   * happened during a dropped connection isn't missed. `running` = a foreground voice OR any task.
   */
  async getActiveJob(
    conversationId: string,
  ): Promise<{ job: AgentJob | null; running: boolean; state: RunStateView }> {
    return req(`/api/chat/conversations/${conversationId}/jobs/active`);
  },
  /** Stop a running background job. Progress already saved to the transcript is kept. */
  async cancelJob(conversationId: string, jobId: string): Promise<void> {
    await req(`/api/chat/conversations/${conversationId}/jobs/${jobId}/cancel`, { method: "POST" });
  },
  /**
   * Steer the in-flight turn: inject a message into the run already holding the bot's slot,
   * instead of starting a second turn. Throws ApiError(409) `not_running` if no run is active
   * (the caller should then fall back to a normal send).
   */
  async steer(conversationId: string, parts: Message["parts"]): Promise<void> {
    await req(`/api/chat/conversations/${conversationId}/steer`, {
      method: "POST",
      body: JSON.stringify({ parts }),
    });
  },

  // ---------- settings: per-user model credentials ----------
  /** Read the caller's stored model credential (masked — never the plaintext key). */
  async getCredentials(): Promise<ModelCredentialsView> {
    return (await req<{ credentials: ModelCredentialsView }>("/api/settings/credentials"))
      .credentials;
  },
  /**
   * Store/replace the caller's model credential. `apiKey` is optional on update — omit it
   * to keep the stored key and change only baseUrl / defaultModel. Returns the masked view.
   */
  async putCredentials(input: {
    apiKey?: string;
    baseUrl?: string | null;
    defaultModel?: string | null;
  }): Promise<ModelCredentialsView> {
    return (
      await req<{ credentials: ModelCredentialsView }>("/api/settings/credentials", {
        method: "PUT",
        body: JSON.stringify(input),
      })
    ).credentials;
  },
  /** Remove the caller's stored model credential. */
  async deleteCredentials(): Promise<void> {
    await req("/api/settings/credentials", { method: "DELETE" });
  },
  /**
   * Fetch the models the provider exposes for the caller's stored key + base URL. Returns an
   * empty list plus a `note` (not an error) when the provider has no catalog or is unreachable,
   * so callers fall back to manual model entry. Throws ApiError(400) only when no key is stored.
   */
  async listModels(): Promise<{ models: ModelInfo[]; note?: string }> {
    return req("/api/settings/models");
  },
};
