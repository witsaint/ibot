"use client";

import { useState } from "react";
import { BookOpen, ExternalLink, Monitor, RotateCw } from "lucide-react";
import { PreviewTabs, type PreviewTab } from "@/components/ui/PreviewTabs";
import styles from "./design.module.css";

const TABS = (
  [
    {
      id: "desktop",
      title: "桌面",
      kind: "desktop",
      icon: <Monitor size={15} className="workspace-preview-mark" />,
    },
    { id: "paper", title: "纸页间 · 中文读书笔记", kind: "web" },
    { id: "trails", title: "山间步道 · 周末旅行计划", kind: "web" },
    {
      id: "reading",
      title: "阅读清单 · 网页图标",
      kind: "web",
      icon: <BookOpen size={17} className="workspace-preview-mark" />,
    },
    {
      id: "image",
      title: "图片图标 · 保持原始比例和颜色",
      kind: "web",
      icon: <img src="/icon.png" alt="" className="workspace-preview-icon" data-loaded="true" />,
    },
  ] satisfies PreviewTab[]
).map((tab) => ({ ...tab, panelId: "design-preview-panel" }));

/** Local interaction only: never mounts DesktopPanel or connects to a sandbox. */
export function PreviewTabsDemo() {
  const [active, setActive] = useState("paper");
  const [refreshCount, setRefreshCount] = useState(0);
  const selected = TABS.find((tab) => tab.id === active)!;
  return (
    <div className="card">
      <div className="workspace-preview-toolbar">
        <PreviewTabs items={TABS} value={active} onChange={setActive} idPrefix="design-preview" />
        {selected.kind === "web" && (
          <>
            <span className="workspace-preview-title">{selected.title}</span>
            <div className="workspace-preview-actions">
              <button
                type="button"
                className="btn btn-sm"
                aria-label="刷新预览示例"
                onClick={() => setRefreshCount((count) => count + 1)}
              >
                <RotateCw size={14} />
              </button>
              <button type="button" className="btn btn-sm" aria-label="在新窗口打开示例" disabled>
                <ExternalLink size={14} />
              </button>
            </div>
          </>
        )}
      </div>
      <div
        id="design-preview-panel"
        role="tabpanel"
        aria-labelledby={`design-preview-tab-${TABS.indexOf(selected)}`}
        style={{ padding: "16px 20px" }}
      >
        <p className={styles.hint} style={{ margin: 0 }}>
          选中：{selected.title}。点击切换，悬停查看完整标题，也可以使用方向键切换。
        </p>
        <p className={styles.hint} style={{ marginBottom: 0 }}>
          选中时云雾流动，未选中时静止。球体尺寸和图标位置保持不变。
        </p>
        {refreshCount > 0 && (
          <p className={styles.hint} role="status" style={{ marginBottom: 0 }}>
            已刷新示例 {refreshCount} 次。
          </p>
        )}
      </div>
    </div>
  );
}
