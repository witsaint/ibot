"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Monitor, RotateCw } from "lucide-react";
import type { WebPreview } from "@i-bot/types";
import { DesktopPanel } from "./DesktopPanel";
import { PreviewTabs } from "./ui/PreviewTabs";

/** Desktop stays mounted while a separate iframe shows the project's actual running service. */
export function WorkspacePreview({
  botId,
  previews,
  onDesktopActive,
}: {
  botId: string;
  previews: WebPreview[];
  onDesktopActive: (active: boolean) => void;
}) {
  const [active, setActive] = useState("desktop");
  const [refresh, setRefresh] = useState(0);
  const lastOpened = useRef("");
  const keyFor = (preview: WebPreview) => `${preview.sandboxId}:${preview.projectDir}`;
  useEffect(() => {
    const newest = previews.at(-1);
    if (!newest) return;
    const key = `${newest.sandboxId}:${newest.projectDir}`;
    const signature = `${key}:${newest.url}:${newest.iconPath ?? ""}`;
    if (lastOpened.current !== signature) {
      lastOpened.current = signature;
      setActive(key);
    }
  }, [previews]);
  const selected = previews.find((preview) => keyFor(preview) === active);
  return (
    <>
      <div className="workspace-preview-toolbar" data-web-selected={Boolean(selected)}>
        <PreviewTabs
          idPrefix="workspace"
          value={active}
          onChange={setActive}
          items={[
            {
              id: "desktop",
              title: "桌面",
              kind: "desktop",
              panelId: "workspace-desktop-panel",
              icon: <Monitor size={15} className="workspace-preview-mark" />,
            },
            ...previews.map((preview) => ({
              id: keyFor(preview),
              title: preview.title,
              kind: "web" as const,
              panelId: "workspace-web-panel",
              icon: <PreviewIcon preview={preview} />,
            })),
          ]}
        />
        {selected && (
          <>
            <span className="workspace-preview-title" title={selected.title}>
              {selected.title}
            </span>
            <div className="workspace-preview-actions">
              <button
                type="button"
                className="btn btn-sm"
                aria-label="刷新网页预览"
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RotateCw size={14} />
              </button>
              <a
                className="btn btn-sm"
                href={selected.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="在新窗口打开网页预览"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </>
        )}
      </div>
      <div
        role="tabpanel"
        id="workspace-desktop-panel"
        aria-labelledby="workspace-tab-0"
        hidden={active !== "desktop"}
        style={{
          flex: 1,
          minHeight: 0,
          display: active === "desktop" ? "flex" : "none",
          flexDirection: "column",
        }}
      >
        <DesktopPanel botId={botId} onActive={onDesktopActive} />
      </div>
      {selected && (
        <div
          role="tabpanel"
          id="workspace-web-panel"
          aria-labelledby={`workspace-tab-${previews.indexOf(selected) + 1}`}
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          <iframe
            key={`${selected.url}:${refresh}`}
            src={selected.url}
            title={`${selected.title}网页预览`}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            style={{
              flex: 1,
              width: "100%",
              minHeight: 0,
              border: 0,
              background: "var(--surface)",
            }}
          />
        </div>
      )}
    </>
  );
}

function PreviewIcon({ preview }: { preview: WebPreview }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  // Older previews may have no generated icon. Try the site's own conventional icon paths.
  const iconPaths = [
    preview.iconPath,
    "/favicon.ico",
    "/icon.svg",
    "/icon.png",
    "/apple-touch-icon.png",
  ].filter((path): path is string => Boolean(path));
  const iconUrl = iconPaths
    .map((path) => new URL(path, preview.url).href)
    .find((url) => !failedUrls.includes(url));
  const iconLoaded = Boolean(iconUrl && loadedUrl === iconUrl);
  return (
    <>
      {iconUrl && (
        <img
          key={iconUrl}
          src={iconUrl}
          alt=""
          className="workspace-preview-icon"
          data-loaded={iconLoaded}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedUrl(iconUrl)}
          onError={() => setFailedUrls((urls) => [...urls, iconUrl])}
        />
      )}
    </>
  );
}
