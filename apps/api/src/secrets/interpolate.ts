/**
 * `{{secrets.NAME}}` interpolation for commands run in the box.
 *
 * The point of this module is what it does NOT do: it never substitutes a secret's plaintext into
 * the command text. Instead each `{{secrets.NAME}}` is rewritten to a shell env-var reference
 * (`"$IBOT_SECRET_NAME"`), and the resolved plaintext is returned SEPARATELY as an `env` map for
 * `handle.run`'s `envs` channel. So the value reaches the process environment while the command
 * string — the thing that shows up in `ps`, shell history, and any log — carries only the
 * reference. The model, which authored the command with the placeholder, likewise never sees the
 * value.
 *
 * Pair this with `guardSecretReadback` on the command: injecting a secret into the environment is
 * only safe if the same command can't turn around and print the environment back out.
 */
import { resolveSecretValues } from "./vault.js";
import type { Database } from "@i-bot/db";

/** `{{secrets.NAME}}` / `{{ secrets.NAME }}` — NAME is the vault reference name. */
const PLACEHOLDER_RE = /\{\{\s*secrets\.([A-Za-z0-9_]{1,120})\s*\}\}/g;

/** The env-var a placeholder maps to. Deterministic and collision-free within the `[A-Za-z0-9_]` grammar. */
export function envVarFor(name: string): string {
  return `IBOT_SECRET_${name}`;
}

/** Extract the distinct secret names referenced by `{{secrets.NAME}}` in a string. */
export function referencedSecretNames(command: string): string[] {
  const names = new Set<string>();
  for (const m of command.matchAll(PLACEHOLDER_RE)) names.add(m[1]!);
  return [...names];
}

export interface Interpolated {
  /** command with each `{{secrets.NAME}}` replaced by `"$IBOT_SECRET_NAME"` (quoted for the shell) */
  command: string;
  /** env map to pass as `handle.run`'s `env` — only the names actually referenced and resolved */
  env: Record<string, string>;
  /** referenced names that had no matching secret for this bot (caller decides if that's fatal) */
  missing: string[];
}

/**
 * Rewrite `{{secrets.NAME}}` placeholders to env-var references and resolve their values for `botId`
 * (tenant-scoped in the vault). A referenced name with no matching secret is left as an empty
 * env-var reference and reported in `missing` — we never leave a literal `{{secrets.X}}` in the
 * command (that would send the braces to the shell), and we never guess a value.
 */
export async function interpolateSecrets(
  db: Database,
  botId: string,
  command: string,
): Promise<Interpolated> {
  const names = referencedSecretNames(command);
  if (names.length === 0) return { command, env: {}, missing: [] };

  const values = await resolveSecretValues(db, botId, names);
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (name in values) env[envVarFor(name)] = values[name]!;
    else missing.push(name);
  }

  const command2 = command.replace(PLACEHOLDER_RE, (_all, name: string) => `"$${envVarFor(name)}"`);
  return { command: command2, env, missing };
}

/**
 * Refuse commands that would read the process environment back out. Once we inject a secret as an
 * env var, a command like `env`, `printenv`, `cat /proc/self/environ`, or `set` could echo it
 * straight into stdout — which the tool returns to the model and the transcript. This gate is what
 * stops a (possibly cross-tenant, e.g. a shared skill's) command from exfiltrating an injected
 * secret that way. It is a coarse defense — the shell is Turing-complete and a determined author
 * can still `curl` a value out — but it closes the trivial readback path, and the real isolation
 * guarantee is that resolution is tenant-scoped so only the bot's OWN secrets are ever present.
 *
 * Call this on the MODEL-AUTHORED command (the raw string with `{{secrets.NAME}}` placeholders),
 * BEFORE `interpolateSecrets` — interpolation itself emits `$IBOT_SECRET_` references, so guarding
 * the rewritten command would always trip. Guarding the raw command also lets us catch a model
 * that tries to name the injected env var directly (`echo $IBOT_SECRET_TOKEN`) instead of using a
 * placeholder — that is an exfiltration attempt and is refused here.
 *
 * Returns the matched reason when the command should be blocked, or null when it's allowed.
 */
export function guardSecretReadback(command: string): string | null {
  // Normalize whitespace for matching; the checks are intentionally broad (substring/word-ish).
  const c = command.toLowerCase();
  const patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /\bprintenv\b/, reason: "printenv" },
    // bare `env` (dumps everything) or `env | …` / `env; …`, but NOT `env FOO=1 cmd` (sets & runs)
    { re: /\benv\b\s*(?:-\S+\s*)*(?:$|[;|&>])/, reason: "env" },
    { re: /\bset\b\s*(?:$|;|\||&|>)/, reason: "set" }, // bare `set` (dumps shell vars), not `set -e`
    { re: /\bexport\b\s*(?:-p)?\s*(?:$|;|\||&|>)/, reason: "export -p" },
    { re: /\/proc\/(?:self|\d+|\$?[a-z_]+)\/environ/, reason: "/proc/*/environ" },
    { re: /\bibot_secret_/, reason: "IBOT_SECRET_ reference outside a placeholder" },
    { re: /\$\{?ibot_secret_/, reason: "$IBOT_SECRET_ expansion" },
  ];
  for (const { re, reason } of patterns) {
    if (re.test(c)) return reason;
  }
  return null;
}
