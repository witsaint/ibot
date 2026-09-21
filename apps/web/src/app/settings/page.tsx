"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ModelCredentialsView, ModelInfo } from "@i-bot/types";
import { api, ApiError } from "@/lib/api";

/**
 * Settings — the tenant's own model credential. Multi-tenant by design: the platform never
 * lends its key, so a bot can't run a turn until its owner stores one here. We keep the key
 * encrypted at rest and only ever show a last-4 hint (`····KeUy`); the plaintext is
 * write-only from the UI's side. Base URL is optional (bring-your-own gateway), and
 * `defaultModel` prefills new-bot creation.
 */
/**
 * Coerce a user-typed gateway URL into something the server's `.url()` check accepts.
 * People type `apiproxy.paigod.work/v1` without a scheme; the gateway is always https,
 * so we prepend it rather than bouncing the save with a cryptic 400. Blank → null.
 */
function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export default function SettingsPage() {
  const router = useRouter();
  const [cred, setCred] = useState<ModelCredentialsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // model catalog fetched from the provider — powers the default-model datalist. `note` carries
  // a soft failure ("provider timed out" / "no catalog"); the field stays free-text either way.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getCredentials()
      .then((c) => {
        setCred(c);
        setBaseUrl(c.baseUrl ?? "");
        setDefaultModel(c.defaultModel ?? "");
        return null;
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/");
        else setCred({ configured: false, keyHint: null, baseUrl: null, defaultModel: null });
      });
  }, [router]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const typedKey = apiKey.trim();
      const next = await api.putCredentials({
        // omit the key on update so the stored one is kept; only send it when re-entered
        ...(typedKey ? { apiKey: typedKey } : {}),
        baseUrl: normalizeBaseUrl(baseUrl),
        defaultModel: defaultModel.trim() || null,
      });
      setCred(next);
      setApiKey(""); // never keep the plaintext around
      setSaved(true);
    } catch (err) {
      // A network/CORS-blocked request throws a bare TypeError ("Failed to fetch") — surface
      // something actionable instead of a blank "Failed to save".
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? `保存失败:${err.message}(检查网络 / 是否已登录)`
            : "保存失败",
      );
    } finally {
      setBusy(false);
    }
  }

  async function fetchModels() {
    setModelsBusy(true);
    setModelsNote(null);
    try {
      const { models: list, note } = await api.listModels();
      setModels(list);
      // Empty list → surface the note; a non-empty list with a note (rare) still lists them.
      if (list.length === 0) setModelsNote(note ?? "没有可用模型");
      else if (note) setModelsNote(note);
    } catch (err) {
      setModelsNote(err instanceof ApiError ? err.message : "拉取失败(检查网络 / 是否已登录)");
    } finally {
      setModelsBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.deleteCredentials();
      setCred({ configured: false, keyHint: null, baseUrl: null, defaultModel: null });
      setApiKey("");
      setBaseUrl("");
      setDefaultModel("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  const keyPlaceholder = cred?.configured ? `Stored — ${cred.keyHint}` : "sk-… or your gateway key";

  return (
    <main
      className="container"
      style={{ paddingTop: 32, paddingBottom: 64, maxWidth: 640, overflowY: "auto" }}
    >
      <h1>Settings</h1>
      <p className="muted" style={{ fontSize: 13, marginTop: 3, marginBottom: 24 }}>
        Your model API key powers every bot you own. It&apos;s stored encrypted and never shown
        again — only a last-4 hint.
      </p>

      {cred === null ? (
        <div style={{ display: "grid", placeItems: "center", padding: 60 }}>
          <span className="spinner" />
        </div>
      ) : (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
            <span className={`dot ${cred.configured ? "dot-ok" : "dot-warn"}`} />
            <span style={{ fontSize: 13, fontWeight: 540 }}>
              {cred.configured ? "Model key configured" : "No model key yet"}
            </span>
          </div>

          <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 15 }}>
            <div className="field">
              <label className="label" htmlFor="api-key">
                Model API key
              </label>
              <input
                id="api-key"
                className="input"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={keyPlaceholder}
              />
              <span className="muted" style={{ fontSize: 11.5 }}>
                {cred.configured
                  ? "Stored and encrypted. Leave blank to keep it — you can change the base URL or model below without re-entering the key."
                  : "Required. Sent once, encrypted at rest."}
              </span>
            </div>

            <div className="field">
              <label className="label" htmlFor="base-url">
                Gateway base URL <span className="muted">(optional)</span>
              </label>
              <input
                id="base-url"
                className="input"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://apiproxy.paigod.work/v1"
              />
              <span className="muted" style={{ fontSize: 11.5 }}>
                Point at your own Anthropic-compatible gateway. Leave blank for the default.
              </span>
            </div>

            <div className="field">
              <label className="label" htmlFor="default-model">
                Default model <span className="muted">(optional)</span>
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                <input
                  id="default-model"
                  className="input"
                  list="model-catalog"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder="pa/claude-opus-5-ppinfra"
                  style={{ fontFamily: "var(--font-mono)", flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={fetchModels}
                  disabled={modelsBusy || !cred.configured}
                  title={cred.configured ? "从 base URL 拉取模型列表" : "先保存 API Key"}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {modelsBusy ? <span className="spinner" /> : "拉取模型"}
                </button>
              </div>
              <datalist id="model-catalog">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </datalist>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {modelsNote
                  ? modelsNote
                  : models.length > 0
                    ? `已拉取 ${models.length} 个模型 — 从下拉选择或手动输入。Prefills new bots.`
                    : "Prefills the model when you create a new bot. 保存 Key 后可点「拉取模型」。"}
              </span>
            </div>

            {error && <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{error}</div>}
            {saved && <div style={{ fontSize: 12.5, color: "var(--accent)" }}>Saved.</div>}

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || (!cred.configured && !apiKey.trim())}
              >
                {busy ? <span className="spinner" /> : "Save"}
              </button>
              {cred.configured && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  onClick={remove}
                  disabled={busy}
                >
                  Remove key
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
