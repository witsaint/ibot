"use client";

import { GraduationCap, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { Skill, SkillDraft } from "@i-bot/types";
import { api } from "@/lib/api";
import { errorText } from "@/lib/errors";

/**
 * Review-before-publish for a distilled skill. `analyzeSkill` produces a DRAFT from the conversation's
 * action trace; this dialog is the human gate — the reviewer edits the name/when-to-use/playbook and
 * confirms the `{{secrets.NAME}}` list before it's written as a bot-scoped skill. Nothing is saved
 * until "保存经验" succeeds. Secret NAMES only ever appear here (never values) — the playbook already
 * had literals rewritten to `{{secrets.NAME}}` upstream.
 */
export function SkillReviewDialog({
  botId,
  draft,
  onClose,
  onSaved,
}: {
  botId: string;
  draft: SkillDraft;
  onClose: () => void;
  onSaved: (skill: Skill) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [playbook, setPlaybook] = useState(draft.playbook);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Secret NAMES the playbook references. Kept in sync with the edited text so a reviewer who removes
  // a {{secrets.X}} line doesn't leave a dangling declared secret (and vice-versa).
  const secretRefs = useMemo(() => {
    const found = new Set<string>();
    for (const m of playbook.matchAll(/\{\{secrets\.([A-Za-z0-9_]+)\}\}/g)) {
      if (m[1]) found.add(m[1]);
    }
    return [...found];
  }, [playbook]);

  const save = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const skill = await api.saveSkill(botId, {
        ...draft,
        name: name.trim(),
        description: description.trim(),
        playbook: playbook.trim(),
        secretRefs,
      });
      onSaved(skill);
    } catch (err) {
      setError(errorText(err, { fallback: "保存失败,请重试。" }));
    } finally {
      setSaving(false);
    }
  }, [botId, draft, name, description, playbook, secretRefs, onSaved]);

  const canSave =
    name.trim().length > 0 && description.trim().length > 0 && playbook.trim().length > 0;
  const fieldStyle = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--ink)",
    fontSize: 13,
    fontFamily: "inherit",
    resize: "vertical" as const,
  };
  const labelStyle = { fontSize: 12, color: "var(--ink-secondary)", fontWeight: 500 };

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "88vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 20,
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border)",
          background: "var(--bg)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GraduationCap size={18} strokeWidth={2} color="var(--ink-secondary)" />
          <div style={{ fontSize: 15, fontWeight: 600 }}>提炼为经验</div>
        </div>
        <div
          style={{ fontSize: 12.5, color: "var(--ink-secondary)", lineHeight: 1.5, marginTop: -6 }}
        >
          这是根据这次对话自动生成的草稿,确认或修改后保存。之后这个 bot 遇到类似任务会参考它。
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={fieldStyle} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>何时使用</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            style={fieldStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={labelStyle}>操作步骤(playbook)</span>
          <textarea
            value={playbook}
            onChange={(e) => setPlaybook(e.target.value)}
            rows={10}
            style={{
              ...fieldStyle,
              fontFamily: "var(--font-mono, ui-monospace), monospace",
              lineHeight: 1.55,
            }}
          />
        </label>

        {secretRefs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelStyle}>引用的密钥(仅名称,值由 bot 的密钥库提供)</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {secretRefs.map((s) => (
                <code
                  key={s}
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--ink-secondary)",
                  }}
                >
                  {`{{secrets.${s}}}`}
                </code>
              ))}
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              height: 34,
              padding: "0 14px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--ink-secondary)",
              fontSize: 13,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !canSave}
            className="btn btn-primary"
            style={{
              height: 34,
              padding: "0 16px",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              cursor: saving || !canSave ? "not-allowed" : "pointer",
              opacity: canSave ? 1 : 0.6,
            }}
          >
            {saving && <Loader2 size={13} strokeWidth={2.2} className="spin" />}
            {saving ? "保存中…" : "保存经验"}
          </button>
        </div>
      </div>
    </div>
  );
}
