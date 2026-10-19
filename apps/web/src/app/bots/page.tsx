"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot as BotIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Bot } from "@i-bot/types";
import { api, ApiError } from "@/lib/api";
import { redirectToSignIn } from "@/lib/session";
import { CreateBotDialog } from "@/components/CreateBotDialog";
import { BotAvatarValue } from "@/lib/avatar";

export default function BotsPage() {
  const router = useRouter();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api
      .listBots()
      .then(setBots)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) redirectToSignIn();
      });
  }, [router]);

  useEffect(load, [load]);

  return (
    <main className="container" style={{ paddingTop: 32, paddingBottom: 64, overflowY: "auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <div>
          <h1>Bots</h1>
          <p className="muted" style={{ fontSize: 13, marginTop: 3 }}>
            Each bot runs on its own isolated cloud desktop.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          New bot
        </button>
      </div>

      {bots === null ? (
        <div style={{ display: "grid", placeItems: "center", padding: 80 }}>
          <span className="spinner" />
        </div>
      ) : bots.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(268px, 1fr))",
            gap: 14,
          }}
        >
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} />
          ))}
        </div>
      )}

      {creating && (
        <CreateBotDialog
          onClose={() => setCreating(false)}
          onSaved={(bot) => router.push(`/bots/${bot.id}`)}
        />
      )}
    </main>
  );
}

function BotCard({ bot }: { bot: Bot }) {
  const statusTone: Record<string, string> = {
    active: "dot-ok",
    creating: "dot-warn",
    idle: "dot-muted",
    paused: "dot-muted",
    error: "dot-danger",
  };
  return (
    <Link
      href={`/bots/${bot.id}`}
      className="card card-hover"
      style={{ padding: 16, display: "block" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--bg-subtle)",
            display: "grid",
            placeItems: "center",
            fontSize: 15,
            color: "var(--ink-secondary)",
            overflow: "hidden",
          }}
        >
          {BotAvatarValue({ value: bot.avatar, size: 32, title: bot.name }) ?? (
            <BotIcon size={17} strokeWidth={1.7} />
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontWeight: 540,
              fontSize: 14,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {bot.name}
          </div>
          <div className="muted" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
            {bot.model}
          </div>
        </div>
      </div>
      <p
        className="secondary"
        style={{
          fontSize: 12.5,
          margin: 0,
          minHeight: 34,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {bot.description || "No description."}
      </p>
      <div className="divider" style={{ margin: "12px 0 10px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className={`dot ${statusTone[bot.status] ?? "dot-muted"}`} />
        <span className="muted" style={{ fontSize: 12, textTransform: "capitalize" }}>
          {bot.status}
        </span>
      </div>
    </Link>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      className="card"
      style={{
        padding: 48,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        borderStyle: "dashed",
        boxShadow: "none",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          border: "1px solid var(--border)",
          display: "grid",
          placeItems: "center",
          marginBottom: 14,
          fontSize: 18,
          color: "var(--ink-secondary)",
        }}
      >
        <BotIcon size={20} strokeWidth={1.7} />
      </div>
      <h2 style={{ marginBottom: 4 }}>No bots yet</h2>
      <p className="muted" style={{ fontSize: 13, maxWidth: 320, marginBottom: 18 }}>
        Create your first bot. It gets a private Linux desktop it can see and control.
      </p>
      <button className="btn btn-primary" onClick={onCreate}>
        Create a bot
      </button>
    </div>
  );
}
