/**
 * Per-user settings — currently the tenant's own model credentials. Every route is under
 * `requireAuth` and keys off the session user id, so a user only ever reads/writes their
 * OWN credential row (1:1 via the `user_model_credentials.user_id` unique constraint).
 *
 * The plaintext API key is encrypted at rest (see `../crypto.js`) and NEVER returned by
 * the API or logged — reads expose only `configured` + a last-4 `keyHint`.
 */
import { userModelCredentials } from "@i-bot/db";
import { SecretKind, type ModelCredentialsView, type ModelInfo } from "@i-bot/types";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppBindings } from "../context.js";
import { decryptSecret, encryptSecret, keyHint } from "../crypto.js";
import { normalizeGatewayBaseURL } from "../agent/model.js";
import { deleteSecret, isValidSecretName, listSecrets, putSecret } from "../secrets/vault.js";

/** Anthropic default when the user stored no gateway base URL. */
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
/** Cap the catalog fetch so a slow/blocked gateway can't hang the settings request. */
const MODELS_FETCH_TIMEOUT_MS = 10_000;

/** Shape of one entry in Anthropic's `GET /v1/models` response `data` array. */
const AnthropicModelsResponse = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })).default([]),
});

/** Body for storing a secret. `value` is the plaintext; it is encrypted server-side and never
 *  returned. `headerName` applies to `header` kind (the header the value is sent under). */
const PutSecret = z.object({
  kind: SecretKind,
  value: z.string().min(1).max(8000),
  headerName: z.string().min(1).max(120).optional(),
});

const PutCredentials = z.object({
  // Optional on update: an existing credential keeps its stored key when apiKey is omitted,
  // so a user can change baseUrl / defaultModel without re-typing the key. Required only on
  // first save (enforced below, since the key is never returned to the client to resend).
  apiKey: z.string().min(8).max(400).optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  defaultModel: z.string().min(1).max(120).nullable().optional(),
});

/** Shape a row (or its absence) into the masked view the web reads. */
function toView(
  row: {
    keyHint: string;
    baseUrl: string | null;
    defaultModel: string | null;
  } | null,
): ModelCredentialsView {
  if (!row) return { configured: false, keyHint: null, baseUrl: null, defaultModel: null };
  return {
    configured: true,
    keyHint: row.keyHint,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
  };
}

export const settingsRoutes = new Hono<AppBindings>()
  // ---------- read my model credential (masked) ----------
  .get("/credentials", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const row = await db.query.userModelCredentials.findFirst({
      where: eq(userModelCredentials.userId, userId),
      columns: { keyHint: true, baseUrl: true, defaultModel: true },
    });
    return c.json({ credentials: toView(row ?? null) });
  })

  // ---------- create/update my model credential ----------
  .put("/credentials", async (c) => {
    const parsed = PutCredentials.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const { apiKey, baseUrl, defaultModel } = parsed.data;

    const existing = await db.query.userModelCredentials.findFirst({
      where: eq(userModelCredentials.userId, userId),
      columns: { apiKeyCiphertext: true, keyHint: true },
    });

    // First save must carry a key (we can't return the stored one to resend). Updates may
    // omit it — we keep the encrypted key already on file and only touch URL / model.
    if (!apiKey && !existing) {
      return c.json({ error: "apiKey required", message: "请填写模型 API Key" }, 400);
    }

    const secret = apiKey
      ? { apiKeyCiphertext: encryptSecret(apiKey), keyHint: keyHint(apiKey) }
      : { apiKeyCiphertext: existing!.apiKeyCiphertext, keyHint: existing!.keyHint };

    const values = {
      ...secret,
      baseUrl: baseUrl ?? null,
      defaultModel: defaultModel ?? null,
      updatedAt: new Date(),
    };

    await db
      .insert(userModelCredentials)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: userModelCredentials.userId, set: values });

    return c.json({
      credentials: toView({
        keyHint: values.keyHint,
        baseUrl: values.baseUrl,
        defaultModel: values.defaultModel,
      }),
    });
  })

  // ---------- delete my model credential ----------
  .delete("/credentials", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    await db.delete(userModelCredentials).where(eq(userModelCredentials.userId, userId));
    return c.body(null, 204);
  })

  // ---------- list the models the provider exposes for my key ----------
  // Queries the provider catalog (Anthropic-compatible `GET /v1/models`) with the caller's OWN
  // stored key, so a bot's model dropdown can be populated from the same base URL the runs use.
  // The key is decrypted just-in-time, sent only to the provider, and NEVER returned or logged.
  // A provider that doesn't expose a catalog (or a blocked gateway) yields `{ models: [], note }`
  // rather than a 500 — the UI then falls back to manual entry.
  .get("/models", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");

    const row = await db.query.userModelCredentials.findFirst({
      where: eq(userModelCredentials.userId, userId),
      columns: { apiKeyCiphertext: true, baseUrl: true },
    });
    if (!row) {
      return c.json({ error: "no_model_key", message: "请先在设置里保存模型 API Key" }, 400);
    }

    const base = row.baseUrl ? normalizeGatewayBaseURL(row.baseUrl) : ANTHROPIC_DEFAULT_BASE;
    const apiKey = decryptSecret(row.apiKeyCiphertext);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/models?limit=1000`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: controller.signal,
      });
      if (!res.ok) {
        return c.json({ models: [] as ModelInfo[], note: `provider returned ${res.status}` });
      }
      const parsed = AnthropicModelsResponse.safeParse(await res.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json({ models: [] as ModelInfo[], note: "unexpected catalog shape" });
      }
      const models: ModelInfo[] = parsed.data.data.map((m) => ({
        id: m.id,
        displayName: m.display_name ?? m.id,
      }));
      return c.json({ models });
    } catch (err) {
      const note =
        err instanceof Error && err.name === "AbortError"
          ? "provider timed out"
          : "provider unreachable";
      return c.json({ models: [] as ModelInfo[], note });
    } finally {
      clearTimeout(timer);
    }
  })

  // ---------- user-scoped secrets (shared across all my bots) ----------
  // These back `{{secrets.NAME}}`. A user manages their OWN vault; the value is write-only from
  // the API's side (never returned), and reads expose only name/kind/hint.
  .get("/secrets", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const secrets = await listSecrets(db, { ownerType: "user", userId });
    return c.json({ secrets });
  })

  .put("/secrets/:name", async (c) => {
    const name = c.req.param("name");
    if (!isValidSecretName(name)) {
      return c.json(
        { error: "invalid name", message: "名称只能包含字母、数字、下划线，长度 ≤120" },
        400,
      );
    }
    const parsed = PutSecret.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

    const { db } = c.get("ctx");
    const userId = c.get("userId");
    const secret = await putSecret(db, {
      owner: { ownerType: "user", userId },
      name,
      kind: parsed.data.kind,
      value: parsed.data.value,
      headerName: parsed.data.headerName,
    });
    return c.json({ secret });
  })

  .delete("/secrets/:name", async (c) => {
    const { db } = c.get("ctx");
    const userId = c.get("userId");
    await deleteSecret(db, { ownerType: "user", userId }, c.req.param("name"));
    return c.body(null, 204);
  });
