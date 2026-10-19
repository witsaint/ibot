/**
 * An in-memory `SandboxFiles` for tests and for any fake handle that doesn't care about files.
 *
 * It exists so that adding a method to `SandboxFiles` doesn't mean editing every test fake: those
 * spread this in and only override what their assertions touch. It is a real (if naive) filesystem
 * rather than a bag of throwing stubs, so a test that incidentally writes and reads back still
 * behaves sensibly.
 *
 * Directory semantics are deliberately minimal: paths are flat strings, a "directory" is any prefix
 * some file starts with, and `list` scans by prefix. That's enough for the interface's contract and
 * not a claim to model POSIX.
 */
import type { SandboxEntry, SandboxFiles } from "../index.js";

/** Normalize away trailing slashes and duplicate separators so keys compare reliably. */
function norm(p: string): string {
  const cleaned = p.replace(/\/+/g, "/").replace(/\/+$/, "");
  return cleaned === "" ? "/" : cleaned;
}

export interface FakeSandboxFiles extends SandboxFiles {
  /** The backing store, for assertions: path → contents. */
  readonly store: Map<string, string>;
  /** Directories created explicitly (so `exists` is true for an empty one). */
  readonly dirs: Set<string>;
}

/** Build a fresh in-memory files surface, optionally pre-seeded with `{ path: contents }`. */
export function fakeSandboxFiles(seed?: Record<string, string>): FakeSandboxFiles {
  const store = new Map<string, string>(Object.entries(seed ?? {}).map(([k, v]) => [norm(k), v]));
  const dirs = new Set<string>();

  const parentOf = (p: string) => {
    const parent = norm(p).replace(/\/+[^/]*$/, "");
    return parent === "" ? "/" : parent;
  };

  return {
    store,
    dirs,
    async readText(path) {
      const key = norm(path);
      const found = store.get(key);
      if (found === undefined) throw new Error(`ENOENT: ${key}`);
      return found;
    },
    async readBytes(path) {
      return new TextEncoder().encode(await this.readText(path));
    },
    async write(path, content) {
      const key = norm(path);
      // mirror the real adapter: writing creates the parent
      dirs.add(parentOf(key));
      store.set(key, content);
    },
    async list(path, opts) {
      const base = norm(path);
      const prefix = base === "/" ? "/" : `${base}/`;
      const depth = opts?.depth ?? 1;
      const out = new Map<string, SandboxEntry>();
      const consider = (full: string, isDir: boolean) => {
        if (!full.startsWith(prefix) || full === base) return;
        const rest = full.slice(prefix.length);
        const parts = rest.split("/").filter(Boolean);
        if (parts.length === 0) return;
        // An entry deeper than `depth` contributes its ancestor directory at the depth boundary.
        const take = Math.min(parts.length, depth);
        const name = parts[take - 1] as string;
        const entryPath = `${prefix}${parts.slice(0, take).join("/")}`;
        const entryIsDir = isDir || take < parts.length;
        out.set(entryPath, {
          name,
          path: entryPath,
          type: entryIsDir ? "dir" : "file",
          size: entryIsDir ? 0 : new TextEncoder().encode(store.get(full) ?? "").length,
        });
      };
      for (const full of store.keys()) consider(full, false);
      for (const d of dirs) consider(d, true);
      return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
    },
    async makeDir(path) {
      const key = norm(path);
      if (dirs.has(key)) return false;
      dirs.add(key);
      return true;
    },
    async remove(path) {
      const key = norm(path);
      store.delete(key);
      dirs.delete(key);
      // removing a directory removes what's under it
      for (const k of [...store.keys()]) if (k.startsWith(`${key}/`)) store.delete(k);
      for (const d of [...dirs]) if (d.startsWith(`${key}/`)) dirs.delete(d);
    },
    async exists(path) {
      const key = norm(path);
      if (store.has(key) || dirs.has(key)) return true;
      // a path is also a directory if something lives under it
      return [...store.keys()].some((k) => k.startsWith(`${key}/`));
    },
    async rename(oldPath, newPath) {
      const from = norm(oldPath);
      const to = norm(newPath);
      const content = store.get(from);
      if (content !== undefined) {
        store.delete(from);
        store.set(to, content);
        return;
      }
      if (!(await this.exists(from))) throw new Error(`ENOENT: ${from}`);
      // directory rename: move every descendant
      for (const k of [...store.keys()]) {
        if (k.startsWith(`${from}/`)) {
          store.set(`${to}${k.slice(from.length)}`, store.get(k) as string);
          store.delete(k);
        }
      }
      for (const d of [...dirs]) {
        if (d === from || d.startsWith(`${from}/`)) {
          dirs.add(`${to}${d.slice(from.length)}`);
          dirs.delete(d);
        }
      }
    },
  };
}
