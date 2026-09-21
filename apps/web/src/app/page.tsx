"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { InteractiveCharacter } from "@/components/landing/InteractiveCharacter";
import { InteractiveStreetlamp } from "@/components/landing/InteractiveStreetlamp";
import { SkyClouds } from "@/components/landing/SkyClouds";
import { InteractivePond } from "@/components/landing/InteractivePond";
import { api, ApiError } from "@/lib/api";
import styles from "./page.module.css";

/**
 * The landing surface IS the auth page. Signed-in visitors bounce straight to `/bots`; everyone
 * else gets sign-in / create-account here at the root. Keeping it at `/` means one entry point and
 * no redirect hop to a separate `/login` route. The project logo sits above the card (and also
 * rides in the browser tab via the favicon wired in layout.tsx).
 */
type Mode = "signin" | "signup";

// Simple, forgiving email shape check — one @, a dotted domain. Not RFC-exhaustive on purpose;
// the server is the real authority, this just catches typos before a round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export default function Home() {
  const router = useRouter();
  // Start in "checking": if there's already a session, we redirect without ever flashing the form.
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(() => {
        if (!cancelled) router.replace("/bots");
        return null;
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  /** Validate the fields we own client-side. Returns true when clear to submit. */
  function validate(): boolean {
    const next: { email?: string; password?: string } = {};
    if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email address.";
    if (password.length < MIN_PASSWORD) {
      next.password = `Password must be at least ${MIN_PASSWORD} characters.`;
    }
    setFieldError(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      if (mode === "signup") {
        await api.signUp(email.trim(), password, name.trim() || email.split("@")[0]!);
      } else {
        await api.signIn(email.trim(), password);
      }
      router.replace("/bots");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Something went wrong";
      setError(
        mode === "signin" && msg.toLowerCase().includes("invalid")
          ? "Wrong email or password."
          : msg,
      );
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <main className={styles.loading}>
        <span className="spinner" />
      </main>
    );
  }

  return (
    <main className={styles.landing}>
      <div className={styles.sceneColumn}>
        <SkyClouds />
        <Image
          src="/ground-tiles.svg"
          alt=""
          width={628}
          height={141}
          className={styles.groundArtwork}
          priority
          draggable={false}
        />
        <InteractiveStreetlamp />
        <InteractivePond />
        <InteractiveCharacter />
      </div>

      <section className={styles.authColumn} aria-label="Account access">
        <div className={styles.authContent}>
          <Brand />

          <div className={`card ${styles.authCard}`}>
            <h1 style={{ fontSize: 17, marginBottom: 3 }}>
              {mode === "signin" ? "Sign in" : "Create your account"}
            </h1>
            <p className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
              {mode === "signin"
                ? "Welcome back. Enter your credentials to continue."
                : "Start building computer-use bots on isolated desktops."}
            </p>

            <form
              onSubmit={submit}
              noValidate
              style={{ display: "flex", flexDirection: "column", gap: 13 }}
            >
              {mode === "signup" && (
                <div className="field">
                  <label className="label" htmlFor="name">
                    Name <span className="muted">(optional)</span>
                  </label>
                  <input
                    id="name"
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ada Lovelace"
                    autoComplete="name"
                  />
                </div>
              )}
              <div className="field">
                <label className="label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  className="input"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (fieldError.email) setFieldError((f) => ({ ...f, email: undefined }));
                  }}
                  placeholder="you@company.com"
                  autoComplete="email"
                  aria-invalid={fieldError.email ? true : undefined}
                />
                {fieldError.email && <FieldHint>{fieldError.email}</FieldHint>}
              </div>
              <div className="field">
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (fieldError.password) setFieldError((f) => ({ ...f, password: undefined }));
                  }}
                  placeholder={`At least ${MIN_PASSWORD} characters`}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  aria-invalid={fieldError.password ? true : undefined}
                />
                {fieldError.password && <FieldHint>{fieldError.password}</FieldHint>}
              </div>

              {error && (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--danger)",
                    background: "color-mix(in srgb, var(--danger) 7%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--danger) 22%, transparent)",
                    borderRadius: "var(--radius-sm)",
                    padding: "7px 10px",
                  }}
                >
                  {error}
                </div>
              )}

              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy}
                style={{ marginTop: 2 }}
              >
                {busy ? (
                  <span className="spinner" />
                ) : mode === "signin" ? (
                  "Sign in"
                ) : (
                  "Create account"
                )}
              </button>
            </form>
          </div>

          <p className={styles.modeSwitch}>
            {mode === "signin" ? "No account yet? " : "Already have an account? "}
            <button
              className={styles.modeButton}
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setFieldError({});
              }}
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12, color: "var(--danger)", marginTop: 1 }}>{children}</span>;
}

/**
 * The project mark above the form: the logo asset at `/logo.png`. If the file isn't present yet it
 * quietly falls back to the geometric placeholder mark, so the page never shows a broken image.
 */
function Brand() {
  const [logoOk, setLogoOk] = useState(true);
  return (
    <div className={styles.brand}>
      {logoOk ? (
        <Image
          src="/logo.png"
          alt="i-bot"
          width={52}
          height={52}
          className={styles.brandImage}
          priority
          onError={() => setLogoOk(false)}
        />
      ) : (
        <div className={styles.brandFallback}>
          <div className={styles.brandFallbackMark} />
        </div>
      )}
      <span className={styles.brandName}>i-bot</span>
    </div>
  );
}
