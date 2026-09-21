"use client";

import { useEffect, useState } from "react";
import type { Bot, ModelInfo } from "@i-bot/types";
import { api, ApiError } from "@/lib/api";
import { AvatarPicker } from "@/components/AvatarPicker";
import { type AvatarConfig, DEFAULT_AVATAR, parseAvatar, serializeAvatar } from "@/lib/avatar";

/**
 * The bot profile modal, shared by the bots grid empty-state, the grid header, the left rail's
 * "＋", and the rail's right-click "Edit profile". A bot is the unit of work here — one bot, one
 * isolated desktop — so the form stays deliberately small: name + avatar + model + optional
 * description/prompt.
 *
 * Two modes on one form: no `bot` → create (model prefilled from the user's saved `defaultModel`);
 * a `bot` → edit (fields seeded from it, saved via PATCH). Each bot carries its OWN model, editable
 * here and pickable from the provider catalog via "拉取模型". On success it fires `ibot:bots-changed`
 * so the rail re-lists without prop-drilling, then calls `onSaved`.
 */
export function CreateBotDialog({
  bot,
  onClose,
  onSaved,
}: {
  /** present → edit this bot; absent → create a new one */
  bot?: Bot;
  onClose: () => void;
  onSaved: (bot: Bot) => void;
}) {
  const editing = bot !== undefined;
  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(bot?.systemPrompt ?? "");
  const [model, setModel] = useState<string>(bot?.model ?? "");
  const [avatar, setAvatar] = useState<AvatarConfig>(
    (bot && parseAvatar(bot.avatar)) || DEFAULT_AVATAR,
  );
  // Public egress: route this bot's desktop through the clean-IP channel (needed to pass
  // human-verification). Editing seeds from the bot's own value; creating starts at the fleet
  // default (fetched below). A concrete bool is persisted so a later env change won't move it.
  const [sandboxPublic, setSandboxPublic] = useState<boolean>(bot?.sandboxPublic ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // provider model catalog for the dropdown — fetched on demand from the owner's base URL.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);

  // Create only: prefill the model from the user's saved default (best-effort; ignore if unset).
  // Editing keeps the bot's own model as seeded, so we never overwrite it here.
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    void api
      .getCredentials()
      .then((cred) => {
        if (!cancelled && cred.defaultModel) setModel(cred.defaultModel);
        return null;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editing]);

  // Create only: seed the public-egress checkbox from the fleet default (env SANDBOX_PUBLIC). A bot
  // that hasn't chosen inherits it; the user can still override per bot here. Editing keeps the bot's
  // own value. Best-effort — an unreachable /me just leaves the checkbox at its false default.
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    void api
      .me()
      .then((m) => {
        if (!cancelled) setSandboxPublic(m.sandboxPublicDefault);
        return null;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editing]);

  async function fetchModels() {
    setModelsBusy(true);
    setModelsNote(null);
    try {
      const { models: list, note } = await api.listModels();
      setModels(list);
      if (list.length === 0) setModelsNote(note ?? "没有可用模型");
      else if (note) setModelsNote(note);
    } catch (err) {
      setModelsNote(
        err instanceof ApiError
          ? err.status === 400
            ? "先在设置里保存 API Key"
            : err.message
          : "拉取失败",
      );
    } finally {
      setModelsBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedModel = model.trim();
      const saved = editing
        ? await api.updateBot(bot.id, {
            name: name.trim(),
            description: description.trim() || null,
            systemPrompt: systemPrompt.trim(),
            avatar: serializeAvatar(avatar),
            // each bot carries its own model — persist edits (fall back to the bot's current one
            // if the field was cleared, so we never write an empty model).
            ...(trimmedModel ? { model: trimmedModel } : {}),
            sandboxPublic,
          })
        : await api.createBot({
            name: name.trim(),
            description: description.trim() || undefined,
            systemPrompt: systemPrompt.trim() || undefined,
            ...(trimmedModel ? { model: trimmedModel } : {}),
            avatar: serializeAvatar(avatar),
            sandboxPublic,
          });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ibot:bots-changed"));
      }
      onSaved(saved);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : `Failed to ${editing ? "save" : "create"} bot`,
      );
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.28)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 50,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          padding: 22,
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h2 style={{ marginBottom: 16 }}>{editing ? "Edit profile" : "New bot"}</h2>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          <div className="field">
            <label className="label" htmlFor="bot-name">
              Name
            </label>
            <input
              id="bot-name"
              className="input"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Research assistant"
              autoFocus
            />
          </div>
          <div className="field">
            <span className="label">Avatar</span>
            <AvatarPicker value={avatar} onChange={setAvatar} />
          </div>
          <div className="field">
            <label className="label" htmlFor="bot-desc">
              Description <span className="muted">(optional)</span>
            </label>
            <input
              id="bot-desc"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this bot for?"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="bot-prompt">
              System prompt <span className="muted">(optional)</span>
            </label>
            <textarea
              id="bot-prompt"
              className="textarea"
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a careful web-research agent. Prefer the browser tool…"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="bot-model">
              Model <span className="muted">(optional)</span>
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <input
                id="bot-model"
                className="input"
                list="bot-model-catalog"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-sonnet-5"
                style={{ fontFamily: "var(--font-mono)", flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={fetchModels}
                disabled={modelsBusy}
                title="从 base URL 拉取模型列表"
                style={{ whiteSpace: "nowrap" }}
              >
                {modelsBusy ? <span className="spinner" /> : "拉取模型"}
              </button>
            </div>
            <datalist id="bot-model-catalog">
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
                  ? `已拉取 ${models.length} 个模型 — 下拉选择或手动输入。`
                  : "这个 bot 独立的模型。留空用默认。点「拉取模型」列出可用项。"}
            </span>
          </div>

          <div className="field">
            <label
              className="label"
              htmlFor="bot-public"
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
            >
              <input
                id="bot-public"
                type="checkbox"
                checked={sandboxPublic}
                onChange={(e) => setSandboxPublic(e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              公网出口 <span className="muted">(clean IP)</span>
            </label>
            <span className="muted" style={{ fontSize: 11.5 }}>
              桌面走公网 channel(干净出口 IP),需要过人机校验的场景开这个。改动在下次重建桌面时生效。
            </span>
          </div>

          {error && <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{error}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? <span className="spinner" /> : editing ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
