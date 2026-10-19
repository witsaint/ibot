/**
 * Manifest normalization: what a bundle must satisfy before anything is stored, and the content hash
 * that decides "same plugin?" for upgrades and box materialization.
 */
import { PLUGIN_LIMITS } from "@i-bot/types";
import { describe, expect, it } from "vitest";
import { agentToolName, hashManifest, ManifestError, normalizeManifest } from "./manifest.js";

/** The minimum a manifest needs; every array/record field defaults. */
const MINIMAL = {
  key: "@acme/crm",
  version: "1.2.0",
  displayName: "CRM",
  description: "talks to the CRM",
};

describe("normalizeManifest", () => {
  it("fills every optional field so downstream code reads one shape", () => {
    const m = normalizeManifest(MINIMAL, { source: "installed" });
    expect(m.skills).toEqual([]);
    expect(m.mcpServers).toEqual([]);
    expect(m.agents).toEqual([]);
    expect(m.ui).toEqual([]);
    expect(m.files).toEqual([]);
    expect(m.hooks).toEqual([]);
    expect(m.userConfig).toEqual({});
    expect(m.defaultEnabled).toBe(true);
  });

  it("rejects a malformed manifest with the field at fault", () => {
    try {
      normalizeManifest({ ...MINIMAL, key: "Not A Key" }, { source: "installed" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).issues[0]?.path).toBe("key");
    }
  });

  it("strips providedTools from a non-builtin source and records why", () => {
    const m = normalizeManifest(
      { ...MINIMAL, providedTools: [{ name: "run_command", description: "mine now" }] },
      { source: "installed" },
    );
    expect(m.providedTools).toEqual([]);
    expect(m.ignored[0]?.path).toBe("providedTools");
  });

  it("keeps providedTools for a builtin (its implementation is our own code)", () => {
    const m = normalizeManifest(
      { ...MINIMAL, key: "@ibot/core", providedTools: [{ name: "run_command", description: "" }] },
      { source: "builtin" },
    );
    expect(m.providedTools).toHaveLength(1);
  });

  it("rejects a file over the per-file limit", () => {
    const big = "x".repeat(PLUGIN_LIMITS.fileBytes + 1);
    expect(() =>
      normalizeManifest(
        { ...MINIMAL, files: [{ path: "big.bin", content: big }] },
        {
          source: "installed",
        },
      ),
    ).toThrow(ManifestError);
  });

  it("rejects duplicate names within a kind", () => {
    expect(() =>
      normalizeManifest(
        {
          ...MINIMAL,
          skills: [
            { name: "Deploy", description: "a", playbook: "b" },
            { name: "deploy", description: "c", playbook: "d" },
          ],
        },
        { source: "installed" },
      ),
    ).toThrow(/duplicate/);
  });

  it("caps a command hook's timeout at the hard limit", () => {
    expect(() =>
      normalizeManifest(
        {
          ...MINIMAL,
          hooks: [
            {
              on: "tool.before",
              do: { type: "command", command: "./check.sh", timeoutMs: 60_000 },
            },
          ],
        },
        { source: "installed" },
      ),
    ).toThrow(ManifestError);
  });
});

describe("hashManifest", () => {
  it("ignores object key order (jsonb and JSON round-trips both reorder freely)", () => {
    const a = normalizeManifest(MINIMAL, { source: "installed" });
    const b = normalizeManifest(
      { displayName: "CRM", version: "1.2.0", description: "talks to the CRM", key: "@acme/crm" },
      { source: "installed" },
    );
    expect(hashManifest(a)).toBe(hashManifest(b));
  });

  it("changes when content changes", () => {
    const a = normalizeManifest(MINIMAL, { source: "installed" });
    const b = normalizeManifest({ ...MINIMAL, version: "1.2.1" }, { source: "installed" });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });

  it("respects array order (setup steps and A2UI children are positional)", () => {
    const a = normalizeManifest(
      { ...MINIMAL, requiredSecrets: ["A", "B"] },
      { source: "installed" },
    );
    const b = normalizeManifest(
      { ...MINIMAL, requiredSecrets: ["B", "A"] },
      { source: "installed" },
    );
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });
});

describe("tool naming", () => {
  it("folds a scoped key into a provider-legal tool name", () => {
    expect(agentToolName("acme/crm", "researcher")).toBe("agent__acme_crm__researcher");
  });

  it("keeps a local plugin's bot-id key usable as a tool segment", () => {
    const name = agentToolName("local:0b1f4c2e-1111-2222-3333-444455556666", "helper");
    expect(name).toMatch(/^agent__[a-zA-Z0-9_-]+__helper$/);
  });
});
