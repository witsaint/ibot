"use client";

import { notFound } from "next/navigation";
import { useEffect, useState } from "react";
import type { A2uiMessage, Bot } from "@i-bot/types";
import { IBOT_CATALOG_ID } from "@/components/a2ui-catalog";
import { A2uiPanel, A2uiRuntimeProvider } from "@/components/A2uiPanel";
import { AnimatedLogo } from "@/components/AnimatedLogo";
import { ComposerMenu, type ComposerMenuGroup } from "@/components/ui/ComposerMenu";
import { Elapsed } from "@/components/ui/Elapsed";
import { ShimmerText } from "@/components/ui/ShimmerText";
import styles from "./design.module.css";
import { AvatarPicker } from "@/components/AvatarPicker";
import { Chip } from "@/components/ui/Chip";
import { Loader } from "@/components/ui/Loader";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { WalkingBot } from "@/components/ui/WalkingBot";
import { api } from "@/lib/api";
import { PreviewTabsDemo } from "./PreviewTabsDemo";
import { type AvatarConfig, BotAvatar, DEFAULT_AVATAR, parseAvatar } from "@/lib/avatar";

/**
 * Dev-only design sheet: the design tokens as they resolve in the current theme, the ui/
 * primitives, and the wait-state character built from a real bot's avatar. Exists so the visual
 * system can be judged in one place without driving the app. Not linked; 404s in production.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [config, setConfig] = useState<AvatarConfig>(DEFAULT_AVATAR);
  const [source, setSource] = useState<string>("default");
  const [size, setSize] = useState(96);

  // Start from the user's real bots so the character is judged on THEIR avatar, not a default.
  useEffect(() => {
    void api
      .listBots()
      .then((list) => {
        setBots(list);
        const first = list.find((b) => parseAvatar(b.avatar));
        if (first) {
          setConfig(parseAvatar(first.avatar) ?? DEFAULT_AVATAR);
          setSource(first.id);
        }
        return list;
      })
      .catch(() => setBots([]));
  }, []);

  return (
    <main className={styles.page}>
      <header>
        <h1 style={{ marginBottom: 4 }}>Design</h1>
        <p className="muted" style={{ fontSize: "var(--text-label)", margin: 0 }}>
          Design tokens, project components, and A2UI. Dev only.
        </p>
      </header>
      <DesignSection title="Character · avatars and loading">
        <div className={styles.character}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="card" style={{ padding: 20 }}>
              <Label>Character · walking · running · standing</Label>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  flexWrap: "wrap",
                  gap: 40,
                  padding: "18px 12px 8px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <Figure caption="走 620ms">
                  <WalkingBot config={config} height={size} />
                </Figure>
                <Figure caption="跑 420ms">
                  <WalkingBot config={config} height={size} running />
                </Figure>
                <Figure caption="站（停止动画）">
                  <WalkingBot config={config} height={size} walking={false} />
                </Figure>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  paddingTop: 12,
                  fontSize: "var(--text-caption)",
                  color: "var(--ink-muted)",
                }}
              >
                <span>height</span>
                <input
                  type="range"
                  min={40}
                  max={200}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                  aria-label="figure height"
                />
                <span className="mono">{size}px</span>
              </div>
            </div>

            <div className="card" style={{ padding: 20 }}>
              <Label>In chat · LoadingStatus</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 10 }}>
                <LoadingStatus
                  label="思考中"
                  leading={<WalkingBot config={config} height={56} running title="bot 正在处理" />}
                />
                <LoadingStatus label="思考中" leading="grid" />
                <LoadingStatus label="orbit" loader="orbit" />
                <LoadingStatus label="dots" loader="dots" showElapsed={false} />
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <Label>Avatar source</Label>
            <select
              value={source}
              onChange={(e) => {
                const v = e.target.value;
                setSource(v);
                if (v === "default") return setConfig(DEFAULT_AVATAR);
                const b = bots?.find((x) => x.id === v);
                setConfig(parseAvatar(b?.avatar) ?? DEFAULT_AVATAR);
              }}
              style={{
                width: "100%",
                margin: "8px 0 12px",
                height: 30,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-strong)",
                background: "var(--surface)",
                color: "var(--ink)",
                fontSize: "var(--text-label)",
                padding: "0 8px",
              }}
            >
              <option value="default">Default avatar</option>
              {(bots ?? [])
                .filter((b) => parseAvatar(b.avatar))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
            <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 14 }}>
              <span
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  display: "grid",
                  placeItems: "center",
                  flex: "none",
                }}
              >
                <BotAvatar config={config} size={48} />
              </span>
              <span className="muted" style={{ fontSize: "var(--text-caption)" }}>
                头像与 loading 共用发型和表情。loading
                使用提供的身体，服装选项只修改头像。这里的调整不会保存。
              </span>
            </div>
            <AvatarPicker value={config} onChange={setConfig} />
          </div>
        </div>
      </DesignSection>

      {/* ───────── tokens ───────── */}
      <DesignSection
        title="Design tokens"
        note={
          <>
            Source: <code>packages/config/design-tokens.css</code>. Values are read from the current
            theme.
          </>
        }
      >
        <TokenGroup
          title="Neutrals"
          note="pure white grounds; separation comes from hairline borders, not grey fills"
          tokens={[
            ["--bg", "page"],
            ["--bg-subtle", "app chrome, inset panels"],
            ["--surface", "cards, bubbles"],
            ["--surface-hover", "momentary hover only"],
            ["--border", "the primary separator"],
            ["--border-strong", "inputs, emphasis"],
            ["--ink", "primary text"],
            ["--ink-secondary", "secondary text"],
            ["--ink-muted", "captions, timestamps"],
          ]}
        />
        <TokenGroup
          title="Accent"
          note="one teal, key states only. Raw accent is 1.96:1 on white → text ON it uses --accent-fg (dark); accent TEXT on white uses --accent-ink (darkened)"
          tokens={[
            ["--accent", "fills: primary button, live dot"],
            ["--accent-hover", "hover of the above"],
            ["--accent-ink", "accent-coloured text/links on light ground"],
            ["--accent-fg", "text/icon on an accent fill"],
            ["--accent-ring", "focus ring"],
            ["--accent-soft", "selection, tint"],
          ]}
        />
        <TokenGroup
          title="Status"
          note="solid for text/border/dot; -soft for a filled notice ground"
          tokens={[
            ["--ok", ""],
            ["--ok-soft", ""],
            ["--warn", ""],
            ["--warn-soft", ""],
            ["--danger", ""],
            ["--danger-soft", ""],
          ]}
        />
        <TokenGroup
          title="Landing"
          note="fixed white-paper values; ignore the system theme on the public auth surface"
          tokens={[
            ["--landing-bg", ""],
            ["--landing-surface", ""],
            ["--landing-surface-hover", ""],
            ["--landing-border", ""],
            ["--landing-border-strong", ""],
            ["--landing-ink", ""],
            ["--landing-ink-secondary", ""],
            ["--landing-ink-muted", ""],
          ]}
        />
      </DesignSection>
      <DesignSection title="Type scale">
        <div className="card" style={{ padding: 20 }}>
          {(
            [
              ["--text-body", "prose, bubbles, A2UI card text, composer"],
              ["--text-label", "control text, buttons, menu rows"],
              ["--text-caption", "meta: timestamps, hints, elapsed, chips"],
            ] as const
          ).map(([tok, use]) => (
            <div
              key={tok}
              className={styles.typeRow}
              style={{
                display: "grid",
                alignItems: "baseline",
                gap: 16,
                padding: "8px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <code style={{ fontSize: "var(--text-caption)", color: "var(--ink-secondary)" }}>
                {tok}
              </code>
              <span className="mono" style={{ fontSize: "var(--text-caption)" }}>
                <TokenValue name={tok} />
              </span>
              <span style={{ fontSize: `var(${tok})` }}>The quick brown fox — {use}</span>
            </div>
          ))}
          <div
            className={styles.typeRow}
            style={{
              display: "grid",
              gap: 16,
              padding: "10px 0 0",
              fontSize: "var(--text-caption)",
              color: "var(--ink-muted)",
            }}
          >
            <code>--font-sans / --font-mono</code>
            <span />
            <span>
              Geist Sans · <span className="mono">Geist Mono</span>
            </span>
          </div>
        </div>
      </DesignSection>
      <DesignSection title="Geometry · elevation · motion">
        <div className={`card ${styles.geometry}`} style={{ padding: 20 }}>
          <div>
            <Label>Radius</Label>
            <div style={{ display: "flex", gap: 12, paddingTop: 10, alignItems: "flex-end" }}>
              {(["--radius-sm", "--radius-md", "--radius-lg"] as const).map((r) => (
                <div key={r} style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      border: "1px solid var(--border-strong)",
                      borderRadius: `var(${r})`,
                      background: "var(--surface)",
                    }}
                  />
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 6 }}
                  >
                    {r.replace("--radius-", "")} <TokenValue name={r} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <Label>Shadow</Label>
            <div style={{ display: "flex", gap: 14, paddingTop: 10 }}>
              {(["--shadow-sm", "--shadow-md", "--shadow-lg"] as const).map((s) => (
                <div key={s} style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: "var(--radius-md)",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      boxShadow: `var(${s})`,
                    }}
                  />
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-muted)", marginTop: 6 }}
                  >
                    {s.replace("--shadow-", "")}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <Label>Motion</Label>
            <div style={{ paddingTop: 10, fontSize: "var(--text-caption)", lineHeight: 1.7 }}>
              <div>
                <code>--ease</code>{" "}
                <span className="mono">
                  <TokenValue name="--ease" />
                </span>
              </div>
              <div>
                <code>--dur</code>{" "}
                <span className="mono">
                  <TokenValue name="--dur" />
                </span>
              </div>
              <div style={{ color: "var(--ink-muted)", marginTop: 4 }}>
                micro-interactions only; reduced-motion switches ui/ animations off
              </div>
            </div>
          </div>
        </div>
      </DesignSection>
      <DesignSection title="Primitives">
        <div className="card" style={{ padding: 20 }}>
          <Label>Chip · tones</Label>
          <p className="prose" style={{ margin: 0, padding: "8px 0 14px" }}>
            Deployed <Chip tone="ok">live</Chip> to prod · two tests{" "}
            <Chip tone="danger">failing</Chip> · <Chip tone="warn">slow</Chip> ·{" "}
            <Chip tone="info">beta</Chip> · <Chip>draft</Chip>
          </p>
          <Label>ShimmerText · Elapsed</Label>
          <div className={styles.row}>
            <ShimmerText>正在处理</ShimmerText>
            <Elapsed />
          </div>
          <Label>Loader · variants (cell 6)</Label>
          <div style={{ display: "flex", gap: 18, paddingTop: 10, alignItems: "center" }}>
            <Loader variant="drive" cell={6} />
            <Loader variant="dots" cell={6} />
            <Loader variant="orbit" cell={6} />
          </div>
        </div>
      </DesignSection>
      <DesignSection
        title="Project components · controls and menu"
        note="应用中的按钮、表单、卡片和 ComposerMenu。示例操作只更新本页状态。"
      >
        <ProjectComponents />
      </DesignSection>
      <DesignSection
        title="工作区预览 · 渐变 tab"
        note="实际工作区使用的 PreviewTabs。桌面、网页图标与无图标渐变球；操作只更新本页示例。"
      >
        <PreviewTabsDemo />
      </DesignSection>
      <DesignSection
        title="A2UI panel · form controls"
        note={
          <>
            聊天中的 A2UI 卡片。与项目组件共用颜色、字号和圆角；样式限制在 <code>.a2ui-panel</code>{" "}
            内。
          </>
        }
      >
        <div style={{ maxWidth: 420 }} data-a2ui-sample>
          {/* fired actions land in the console — the panel's only observable output on this page */}
          <A2uiRuntimeProvider onAction={(a) => console.info("[design] a2ui action", a)}>
            <A2uiPanel messages={A2UI_SAMPLE} partId="design-sample" />
          </A2uiRuntimeProvider>
        </div>
      </DesignSection>
    </main>
  );
}

/**
 * A representative form: every control that draws its own chrome (CheckBox, ChoicePicker in both
 * modes, Slider, TextField, Button). Mirrors what the model emits via render_ui — flat adjacency
 * list, one `root`, values bound into the data model.
 */
const A2UI_SAMPLE: A2uiMessage[] = [
  { version: "v0.9", createSurface: { surfaceId: "design-sample", catalogId: IBOT_CATALOG_ID } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "design-sample",
      components: [
        { id: "root", component: "Card", child: "col" },
        {
          id: "col",
          component: "Column",
          children: [
            "title",
            "intro",
            "caption",
            "tabs",
            "divider",
            "name",
            "agree",
            "single",
            "multi",
            "level",
            "actions",
          ],
        },
        { id: "title", component: "Text", text: "Sample form", variant: "h3" },
        // body Text renders markdown: this exercises inline code, a link and a bullet list
        {
          id: "intro",
          component: "Text",
          text: "Body text at the chat size, with `inline code`, a [link](https://a2ui.org) and a list:\n\n- first point\n- second point",
        },
        {
          id: "caption",
          component: "Text",
          text: "Caption · meta text, 12px, muted",
          variant: "caption",
        },
        {
          id: "tabs",
          component: "Tabs",
          tabs: [
            { title: "Media", child: "mediaList" },
            { title: "Result", child: "resultCol" },
          ],
        },
        { id: "mediaList", component: "List", children: ["img", "audio"] },
        {
          id: "img",
          component: "Image",
          url: "https://picsum.photos/seed/ibot/360/120",
          description: "sample image",
          variant: "smallFeature",
        },
        {
          id: "audio",
          component: "AudioPlayer",
          url: "https://www.w3schools.com/html/horse.mp3",
          description: "AudioPlayer with a description",
        },
        { id: "resultCol", component: "Column", children: ["resultText"] },
        { id: "resultText", component: "Text", text: "Second tab content." },
        { id: "divider", component: "Divider" },
        { id: "name", component: "TextField", label: "Name", value: { path: "/name" } },
        {
          id: "agree",
          component: "CheckBox",
          label: "I agree to the terms",
          value: { path: "/agree" },
        },
        {
          id: "single",
          component: "ChoicePicker",
          label: "Plan (single)",
          variant: "mutuallyExclusive",
          options: [
            { label: "Starter", value: "starter" },
            { label: "Team", value: "team" },
            { label: "Enterprise", value: "enterprise" },
          ],
          value: { path: "/plan" },
        },
        {
          id: "multi",
          component: "ChoicePicker",
          label: "Interests (multiple)",
          variant: "multipleSelection",
          options: [
            { label: "LLM", value: "llm" },
            { label: "Agents", value: "agents" },
            { label: "Design", value: "design" },
          ],
          value: { path: "/interests" },
        },
        {
          id: "level",
          component: "Slider",
          label: "Level",
          min: 0,
          max: 100,
          value: { path: "/level" },
        },
        // all three Button variants side by side: borderless (dismiss) · default · primary (CTA)
        {
          id: "actions",
          component: "Row",
          justify: "end",
          children: ["skip", "reset", "submit"],
        },
        { id: "skipLabel", component: "Text", text: "Skip" },
        {
          id: "skip",
          component: "Button",
          child: "skipLabel",
          variant: "borderless",
          action: { event: { name: "skip", context: {} } },
        },
        { id: "resetLabel", component: "Text", text: "Reset" },
        {
          id: "reset",
          component: "Button",
          child: "resetLabel",
          action: { event: { name: "reset", context: {} } },
        },
        { id: "submitLabel", component: "Text", text: "Submit" },
        {
          id: "submit",
          component: "Button",
          child: "submitLabel",
          variant: "primary",
          action: { event: { name: "submit", context: { form: { path: "/" } } } },
        },
      ],
    },
  },
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: "design-sample",
      path: "/",
      value: { name: "", agree: true, plan: ["team"], interests: ["llm", "design"], level: 42 },
    },
  },
];

/* ───────── helpers ───────── */

function DesignSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section} aria-label={title}>
      <header className={styles.sectionHeader}>
        <h2>{title}</h2>
        {note && <p className="muted">{note}</p>}
      </header>
      {children}
    </section>
  );
}

const MENU_GROUPS: ComposerMenuGroup[] = [
  {
    key: "add",
    title: "添加",
    items: [
      { key: "file", label: "添加文件", desc: "本页示例" },
      { key: "record", label: "录制经验" },
    ],
  },
  {
    key: "skills",
    title: "技能",
    items: [{ key: "summary", label: "整理文档", desc: "插入技能引用" }],
  },
  {
    key: "plugins",
    title: "插件",
    items: [{ key: "plugin", label: "示例插件", disabled: true, hint: "未安装" }],
  },
];

function ProjectComponents() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedback, setFeedback] = useState("尚未操作");
  return (
    <div className={styles.samples}>
      <div className="card" style={{ padding: 20 }}>
        <Label>Buttons · variants and states</Label>
        <div className={styles.row}>
          <button type="button" className="btn" onClick={() => setFeedback("点击了默认按钮")}>
            默认
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setFeedback("点击了主要按钮")}
          >
            主要操作
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setFeedback("点击了无边框按钮")}
          >
            无边框
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setFeedback("点击了危险操作示例")}
          >
            危险操作
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setFeedback("点击了小按钮")}>
            小按钮
          </button>
          <button type="button" className="btn" disabled>
            不可用
          </button>
          <button type="button" className="btn btn-primary" disabled>
            <Loader cell={3} />
            处理中
          </button>
        </div>
      </div>
      <div className={styles.controls}>
        <div className="card" style={{ padding: 20 }}>
          <Label>Fields · input, select, textarea</Label>
          <div className={styles.fields}>
            <div className="field">
              <label className="label" htmlFor="design-name">
                名称
              </label>
              <input id="design-name" className="input" placeholder="输入示例名称" />
            </div>
            <div className="field">
              <label className="label" htmlFor="design-select">
                选项
              </label>
              <select id="design-select" className="input" defaultValue="default">
                <option value="default">默认选项</option>
                <option value="other">其他选项</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="design-description">
                说明
              </label>
              <textarea
                id="design-description"
                className="textarea"
                rows={3}
                placeholder="输入多行内容"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="design-disabled">
                不可编辑
              </label>
              <input id="design-disabled" className="input" disabled value="禁用状态" />
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: 20 }}>
          <Label>ComposerMenu · groups, disabled, keyboard</Label>
          <p className={styles.hint}>打开后使用 ↑ / ↓、Enter 和 Esc，也可以点击菜单项。</p>
          <div className={styles.menuAnchor}>
            {menuOpen && (
              <ComposerMenu
                groups={MENU_GROUPS}
                onPick={(key) => {
                  setFeedback(
                    `选择了：${MENU_GROUPS.flatMap((group) => group.items).find((item) => item.key === key)?.label ?? key}`,
                  );
                  setMenuOpen(false);
                }}
                onClose={() => setMenuOpen(false)}
                footer="示例不会上传文件或启动录制"
              />
            )}
            <button
              type="button"
              className="btn"
              data-composer-anchor
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              打开添加菜单
            </button>
          </div>
          <p className={styles.hint} role="status">
            {feedback}
          </p>
          <Label>AnimatedLogo · hover</Label>
          <div className={styles.row}>
            <AnimatedLogo size={36} />
            <span className="muted">悬停播放，移开停止</span>
          </div>
          <Label>Card · hover</Label>
          <div className={`card card-hover ${styles.hoverCard}`}>悬停查看边框与阴影</div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "var(--ink-muted)",
      }}
    >
      {children}
    </div>
  );
}

function Figure({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      {children}
      <span className="muted" style={{ fontSize: "var(--text-caption)" }}>
        {caption}
      </span>
    </div>
  );
}

/** Reads a custom property's resolved value off :root so the sheet always shows what's live. */
function TokenValue({ name }: { name: string }) {
  const [v, setV] = useState("");
  useEffect(() => {
    setV(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }, [name]);
  return <>{v}</>;
}

function TokenGroup({
  title,
  note,
  tokens,
}: {
  title: string;
  note?: string;
  tokens: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <Label>{title}</Label>
      {note && (
        <div
          style={{
            fontSize: "var(--text-caption)",
            color: "var(--ink-muted)",
            margin: "4px 0 10px",
          }}
        >
          {note}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
          gap: 10,
        }}
      >
        {tokens.map(([tok, use]) => (
          <div key={tok} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 34,
                height: 34,
                flex: "none",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-strong)",
                background: `var(${tok})`,
              }}
            />
            <span style={{ minWidth: 0 }}>
              <code
                style={{
                  display: "block",
                  fontSize: "var(--text-caption)",
                  color: "var(--ink)",
                  whiteSpace: "nowrap",
                }}
              >
                {tok}
              </code>
              <span
                className="mono"
                style={{ display: "block", fontSize: 10.5, color: "var(--ink-muted)" }}
              >
                <TokenValue name={tok} />
              </span>
              {use && (
                <span
                  style={{
                    display: "block",
                    fontSize: 10.5,
                    color: "var(--ink-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {use}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
