/**
 * Takeover-lock behaviour of the sandbox toolset: while a human holds the desktop,
 * `desktop_action` is refused (no fighting over `:0`) EXCEPT read-only screenshots, and the
 * box command is never actually run. Releasing control re-enables input on the next action.
 */
import { randomBytes } from "node:crypto";
import { fakeSandboxFiles, type SandboxHandle } from "@i-bot/core";
import type { Database } from "@i-bot/db";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto.js";
import { buildSandboxTools, CORE_TOOLS } from "./tools.js";

/** A handle that records every shell command so we can assert none ran when locked. */
function recordingHandle(): { handle: SandboxHandle; commands: string[] } {
  const commands: string[] = [];
  const handle: SandboxHandle = {
    id: "row-1",
    provider: "ppio",
    files: fakeSandboxFiles(),
    providerSandboxId: "sbx-1",
    meta: {},
    getHost: (port) => `${port}-sbx-1.example`,
    run: async (command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    detach: () => {},
    destroy: async () => {},
  };
  return { handle, commands };
}

/** Invoke a tool's execute with a minimal options bag (unit context). */
function exec(
  tool: unknown,
  action: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const t = tool as {
    execute: (input: unknown, opts: unknown) => Promise<{ ok: boolean; error?: string }>;
  };
  return t.execute({ action }, { toolCallId: "t1", messages: [] });
}

describe("buildSandboxTools desktop takeover lock", () => {
  it("refuses desktop input while a human holds control and runs nothing on the box", async () => {
    const { handle, commands } = recordingHandle();
    const { tools } = buildSandboxTools(handle, { isHumanInControl: () => true });

    const res = await exec(tools.desktop_action, { type: "left_click", at: { x: 10, y: 20 } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/human/i);
    expect(commands).toHaveLength(0); // never touched the box
  });

  it("refuses ALL gui tools while a human holds control (browser + screenshot too)", async () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle, { isHumanInControl: () => true });

    // Takeover now covers the whole display, not just keyboard/mouse — screenshot is refused too.
    const shot = await exec(tools.desktop_action, { type: "screenshot" });
    expect(shot.ok).toBe(false);
    expect(shot.error).toMatch(/human/i);

    const browse = await exec(tools.browser_action, { type: "screenshot" });
    expect(browse.ok).toBe(false);
    expect(browse.error).toMatch(/human/i);
  });

  it("allows desktop input once control is released", async () => {
    const { handle, commands } = recordingHandle();
    let held = true;
    const { tools } = buildSandboxTools(handle, { isHumanInControl: () => held });

    const blocked = await exec(tools.desktop_action, { type: "left_click" });
    expect(blocked.ok).toBe(false);

    held = false;
    const allowed = await exec(tools.desktop_action, { type: "left_click" });
    expect(allowed.ok).toBe(true);
    expect(commands).toHaveLength(1); // exactly the one click after release
    expect(commands[0]).toContain("xdotool");
  });

  it("defaults to unlocked when no control checker is provided", async () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const res = await exec(tools.desktop_action, { type: "left_click" });
    expect(res.ok).toBe(true);
  });
});

describe("buildSandboxTools mode gating", () => {
  it("full mode exposes the gui tools + run_command, and omits spawn_task unless wired", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle, { mode: "full" });
    expect(tools.browser_action).toBeDefined();
    expect(tools.desktop_action).toBeDefined();
    expect(tools.screenshot).toBeDefined();
    expect(tools.render_ui).toBeDefined();
    expect(tools.run_command).toBeDefined();
    expect(tools.spawn_task).toBeUndefined();
  });

  it("concurrent-safe mode exposes ONLY run_command (no gui tools, no render_ui)", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle, { mode: "concurrent-safe" });
    expect(tools.run_command).toBeDefined();
    expect(tools.browser_action).toBeUndefined();
    expect(tools.desktop_action).toBeUndefined();
    expect(tools.screenshot).toBeUndefined();
    expect(tools.render_ui).toBeUndefined();
    expect(tools.spawn_task).toBeUndefined();
  });

  it("exposes spawn_task when a spawn closure is provided (foreground turn)", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle, {
      spawnTask: async () => ({ taskId: "t-1" }),
    });
    expect(tools.spawn_task).toBeDefined();
  });

  it("omits request_handoff unless an onHandoff callback is wired", () => {
    const { handle } = recordingHandle();
    expect(buildSandboxTools(handle).tools.request_handoff).toBeUndefined();
    expect(buildSandboxTools(handle, { onHandoff: () => {} }).tools.request_handoff).toBeDefined();
  });

  /**
   * `CORE_TOOLS` is the declared vocabulary of the platform's own primitives: it becomes the
   * `@ibot/core` plugin's `providedTools`, and it's what an agent's tool allowlist is validated
   * against. A tool added to the builder but not declared would be invisible to the plugin layer (and
   * unusable in an allowlist), so the two are asserted equal rather than trusted to stay in step.
   */
  it("declares exactly the tools the builder can produce", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle, {
      mode: "full",
      tenant: { db: {} as never, botId: "bot-1" },
      spawnTask: async () => ({ taskId: "t-1" }),
      onHandoff: () => {},
    });
    expect(CORE_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(tools).sort());
  });
});

describe("request_handoff tool", () => {
  it("fires onHandoff with the exact {reason, kind} and returns an ok ack", async () => {
    const { handle } = recordingHandle();
    const calls: Array<{ reason: string; kind: string }> = [];
    const { tools } = buildSandboxTools(handle, { onHandoff: (p) => calls.push(p) });

    const t = tools.request_handoff as {
      execute: (i: unknown, o: unknown) => Promise<{ ok: boolean; text?: string }>;
    };
    const res = await t.execute(
      { reason: "log into Gmail so I can continue", kind: "login" },
      { toolCallId: "h1", messages: [] },
    );

    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/pause/i);
    expect(calls).toEqual([{ reason: "log into Gmail so I can continue", kind: "login" }]);
  });

  it("validates the kind against the HandoffKind enum", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle, { onHandoff: () => {} });
    const schema = (
      tools.request_handoff as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema;
    expect(schema.safeParse({ reason: "do X", kind: "login" }).success).toBe(true);
    expect(schema.safeParse({ reason: "do X", kind: "not-a-kind" }).success).toBe(false);
    expect(schema.safeParse({ reason: "", kind: "otp" }).success).toBe(false); // reason min(1)
  });
});

describe("run_command tool", () => {
  it("runs the command on the box and reports exitCode/stdout", async () => {
    const commands: string[] = [];
    const handle: SandboxHandle = {
      id: "row-1",
      provider: "ppio",
      files: fakeSandboxFiles(),
      providerSandboxId: "sbx-1",
      meta: {},
      getHost: (p) => `${p}-sbx-1.example`,
      run: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "hello", stderr: "" };
      },
      screenshot: async () => new Uint8Array(),
      detach: () => {},
      destroy: async () => {},
    };
    const { tools } = buildSandboxTools(handle);
    const t = tools.run_command as {
      execute: (
        i: unknown,
        o: unknown,
      ) => Promise<{ ok: boolean; exitCode: number; stdout: string }>;
    };
    const res = await t.execute({ command: "echo hello" }, { toolCallId: "c1", messages: [] });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello");
    expect(commands[0]).toContain("echo hello");
  });

  it("scopes into the workdir when one is set", async () => {
    const commands: string[] = [];
    const handle: SandboxHandle = {
      id: "row-1",
      provider: "ppio",
      files: fakeSandboxFiles(),
      providerSandboxId: "sbx-1",
      meta: {},
      getHost: (p) => `${p}-sbx-1.example`,
      run: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      screenshot: async () => new Uint8Array(),
      detach: () => {},
      destroy: async () => {},
    };
    const { tools } = buildSandboxTools(handle, { workdir: "/root/tasks/t-1" });
    const t = tools.run_command as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };
    await t.execute({ command: "ls" }, { toolCallId: "c1", messages: [] });
    expect(commands[0]).toContain("cd");
    expect(commands[0]).toContain("/root/tasks/t-1");
    expect(commands[0]).toContain("ls");
  });
});

/** Call a tool's toModelOutput with the given result output. */
function modelOutput(tool: unknown, output: unknown) {
  const t = tool as {
    toModelOutput?: (o: { toolCallId: string; input: unknown; output: unknown }) => unknown;
  };
  if (!t.toModelOutput) throw new Error("tool has no toModelOutput");
  return t.toModelOutput({ toolCallId: "t1", input: {}, output });
}

describe("buildSandboxTools toModelOutput (screenshots as images)", () => {
  const B64 = "A".repeat(2000); // stand-in for a real base64 PNG (> 1024 guard)

  it("emits an image file part so the vision model sees the screenshot", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const out = modelOutput(tools.screenshot, { ok: true, screenshot: B64 }) as {
      type: string;
      value: Array<{
        type: string;
        data?: { type: string; data: string };
        mediaType?: string;
        text?: string;
      }>;
    };

    expect(out.type).toBe("content");
    const file = out.value.find((p) => p.type === "file");
    expect(file?.mediaType).toBe("image/png");
    expect(file?.data).toEqual({ type: "data", data: B64 });
    // the non-image fields survive as a compact text summary
    const text = out.value.find((p) => p.type === "text");
    expect(text?.text).toContain('"ok":true');
  });

  it("sends an omitted/short screenshot as JSON text, not a mis-decoded image", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const out = modelOutput(tools.screenshot, {
      ok: true,
      screenshot: "[screenshot omitted to save context]",
    }) as { type: string };

    expect(out.type).toBe("json"); // below the length guard → not treated as image bytes
  });

  it("passes a plain (screenshot-free) result through as JSON", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const out = modelOutput(tools.browser_action, { ok: true, text: "hello" }) as {
      type: string;
      value: unknown;
    };

    expect(out.type).toBe("json");
    expect(out.value).toEqual({ ok: true, text: "hello" });
  });
});

describe("render_ui tool (A2UI passthrough)", () => {
  const surface = [
    { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [{ id: "root", component: "Text", text: { path: "/t" } }],
      },
    },
    { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: { t: "hi" } } },
  ];

  it("passes the A2UI messages through verbatim as its output", async () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const t = tools.render_ui as {
      execute: (i: unknown, o: unknown) => Promise<{ ok: boolean; a2ui: unknown[] }>;
    };
    const res = await t.execute({ messages: surface }, { toolCallId: "u1", messages: [] });

    expect(res.ok).toBe(true);
    expect(res.a2ui).toEqual(surface); // verbatim → client re-renders from the stored part
  });

  it("returns only a tiny ack to the model, never the echoed panel", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const out = modelOutput(tools.render_ui, { ok: true, a2ui: surface }) as {
      type: string;
      value: Record<string, unknown>;
    };

    expect(out.type).toBe("json");
    expect(out.value).toEqual({ ok: true, rendered: true }); // no messages re-fed to the model
  });

  it("rejects a message missing the protocol version (structural guard)", () => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);

    const schema = (
      tools.render_ui as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema;
    expect(schema.safeParse({ messages: [{ createSurface: { surfaceId: "s1" } }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ messages: surface }).success).toBe(true);
  });

  // The catalog pre-flight: a panel whose components would be dropped by the client (bad props or
  // no `root`) must come back as ok:false with errors, NOT ok:true — so the model self-corrects
  // instead of the human staring at a stuck `[Loading root...]`.
  type RenderExec = {
    execute: (
      i: unknown,
      o: unknown,
    ) => Promise<{
      ok: boolean;
      a2ui?: unknown[];
      errors?: Array<{ id: string; issues: string[] }>;
    }>;
  };
  const runRender = async (messages: unknown[]) => {
    const { handle } = recordingHandle();
    const { tools } = buildSandboxTools(handle);
    return (tools.render_ui as RenderExec).execute(
      { messages },
      { toolCallId: "v1", messages: [] },
    );
  };

  it("rejects a Button with a `label` prop (basic catalog wants `child`)", async () => {
    const res = await runRender([
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "root", component: "Button", label: "Submit" }],
        },
      },
    ]);

    expect(res.ok).toBe(false);
    expect(res.a2ui).toBeUndefined(); // never hand the client a batch it would silently drop
    const btn = res.errors?.find((e) => e.id === "root");
    expect(btn?.issues.join(" ")).toMatch(/label/i); // the offending key is named back to the model
  });

  it("rejects a TextField with `placeholder` (not in the strict schema)", async () => {
    const res = await runRender([
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [
            { id: "root", component: "TextField", label: "Email", placeholder: "you@example.com" },
          ],
        },
      },
    ]);

    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.issues.join(" ")).toMatch(/placeholder/i);
  });

  it("rejects a Text with an invalid `variant`", async () => {
    const res = await runRender([
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "root", component: "Text", text: "hi", variant: "heading" }],
        },
      },
    ]);

    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.issues.join(" ")).toMatch(/variant/i);
  });

  it("rejects a components batch with no `root` (the other [Loading root…] cause)", async () => {
    const res = await runRender([
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "title", component: "Text", text: "hi" }],
        },
      },
    ]);

    expect(res.ok).toBe(false);
    expect(res.errors?.some((e) => e.id === "root")).toBe(true);
  });

  it("passes an in-place UPDATE (no createSurface, no root) — reuse-surfaceId delta path", async () => {
    // A later render_ui that only mutates an existing surface: no createSurface, so no new `root`
    // is required (the root was declared when the surface was first created). The validator must
    // NOT flag a missing root here, or every valid delta update would be rejected.
    const res = await runRender([
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "heading", component: "Text", text: "Updated", variant: "h3" }],
        },
      },
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: { n: 2 } } },
    ]);

    expect(res.ok).toBe(true);
    expect(res.errors).toBeUndefined();
  });

  it("still rejects a valid delta whose OWN component props are wrong (schema mirror holds)", async () => {
    // No createSurface (an update), so no root is required — but a bad prop on a component this
    // batch DOES declare must still come back as an error.
    const res = await runRender([
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [{ id: "heading", component: "Text", text: "hi", variant: "heading" }],
        },
      },
    ]);

    expect(res.ok).toBe(false);
    expect(res.errors?.some((e) => e.id === "heading")).toBe(true);
  });

  it("passes a well-formed panel through unchanged", async () => {
    const good = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "basic" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [
            { id: "root", component: "Column", children: ["heading", "go"] },
            { id: "heading", component: "Text", text: "Pick one", variant: "h3" },
            { id: "label", component: "Text", text: "Go" },
            { id: "go", component: "Button", child: "label", action: { event: { name: "go" } } },
          ],
        },
      },
    ];

    const res = await runRender(good);
    expect(res.ok).toBe(true);
    expect(res.a2ui).toEqual(good);
  });
});

describe("run_command secret injection", () => {
  // A handle that records both the command text AND the opts (so we can assert the secret rode
  // the `env` channel, not the command string).
  function envRecordingHandle(): {
    handle: SandboxHandle;
    calls: Array<{ command: string; opts?: { env?: Record<string, string> } }>;
  } {
    const calls: Array<{
      command: string;
      opts?: { timeoutMs?: number; env?: Record<string, string> };
    }> = [];
    const handle: SandboxHandle = {
      id: "row-1",
      provider: "ppio",
      files: fakeSandboxFiles(),
      providerSandboxId: "sbx-1",
      meta: {},
      getHost: (p) => `${p}-sbx-1.example`,
      run: async (command: string, opts?: { timeoutMs?: number; env?: Record<string, string> }) => {
        calls.push({ command, opts });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      screenshot: async () => new Uint8Array(),
      detach: () => {},
      destroy: async () => {},
    };
    return { handle, calls };
  }

  // A vault-backed db carrying one bot-scoped secret. Encryption key is set by the imported
  // crypto module; a random one is fine for a round-trip.
  function secretDb(name: string, value: string): Database {
    process.env.SECRETS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
    return {
      query: {
        bots: { findFirst: async () => ({ ownerId: "owner-1" }) },
        tenantSecrets: {
          findMany: async () => [
            {
              name,
              ciphertext: encryptSecret(value),
              kind: "bearer",
              metadata: null,
              ownerType: "bot",
              botId: "bot-1",
              userId: null,
            },
          ],
        },
      },
    } as unknown as Database;
  }

  const runTool = (tools: ReturnType<typeof buildSandboxTools>["tools"]) =>
    tools.run_command as {
      execute: (i: unknown, o: unknown) => Promise<{ ok: boolean; error?: string }>;
    };

  it("injects a referenced secret via env, keeping the value out of the command string", async () => {
    const { handle, calls } = envRecordingHandle();
    const { tools } = buildSandboxTools(handle, {
      tenant: { db: secretDb("TOKEN", "s3cr3t-xyz"), botId: "bot-1" },
    });

    await runTool(tools).execute(
      { command: 'curl -H "Authorization: Bearer {{secrets.TOKEN}}" https://api.example' },
      { toolCallId: "c1", messages: [] },
    );

    expect(calls).toHaveLength(1);
    const { command, opts } = calls[0]!;
    expect(command).not.toContain("s3cr3t-xyz"); // never in the command text
    expect(command).toContain('"$IBOT_SECRET_TOKEN"'); // placeholder → env reference
    expect(opts?.env).toEqual({ IBOT_SECRET_TOKEN: "s3cr3t-xyz" }); // value rode the env channel
  });

  it("refuses a command that tries to read the environment back out", async () => {
    const { handle, calls } = envRecordingHandle();
    const { tools } = buildSandboxTools(handle, {
      tenant: { db: secretDb("TOKEN", "v"), botId: "bot-1" },
    });

    const res = await runTool(tools).execute(
      { command: "printenv" },
      { toolCallId: "c1", messages: [] },
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/environ|secret/i);
    expect(calls).toHaveLength(0); // blocked before it ever reached the box
  });

  it("runs an ordinary command untouched (no env) when it references no secret", async () => {
    const { handle, calls } = envRecordingHandle();
    const { tools } = buildSandboxTools(handle, {
      tenant: { db: secretDb("TOKEN", "v"), botId: "bot-1" },
    });

    await runTool(tools).execute({ command: "echo hi" }, { toolCallId: "c1", messages: [] });

    const { command, opts } = calls[0]!;
    expect(command).toContain("echo hi");
    expect(opts?.env).toBeUndefined();
  });
});

describe("save_skill tool", () => {
  // A handle that records rendered files (base64 writes) so we can assert same-turn rendering.
  function fileRecordingHandle(): { handle: SandboxHandle; commands: string[] } {
    const commands: string[] = [];
    const handle: SandboxHandle = {
      id: "row-1",
      provider: "ppio",
      files: fakeSandboxFiles(),
      providerSandboxId: "sbx-1",
      meta: {},
      getHost: (p) => `${p}-sbx-1.example`,
      run: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      screenshot: async () => new Uint8Array(),
      detach: () => {},
      destroy: async () => {},
    };
    return { handle, commands };
  }

  // A db stub whose skills.insert().values().returning() yields a generated id and records the row.
  // `localPluginId` is what the bot's `local` plugin lookup answers — null models a bot that has
  // none yet (one created before plugins existed, until the backfill runs).
  function skillDb(localPluginId: string | null = "local-plugin-1"): {
    db: Database;
    inserted: Record<string, unknown>[];
  } {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      query: {
        plugins: { findFirst: async () => (localPluginId ? { id: localPluginId } : undefined) },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: "sk-new" }] };
        },
      }),
    } as unknown as Database;
    return { db, inserted };
  }

  it("is offered only when a tenant is wired", () => {
    const { handle } = fileRecordingHandle();
    expect(buildSandboxTools(handle).tools.save_skill).toBeUndefined();
    const { db } = skillDb();
    expect(
      buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } }).tools.save_skill,
    ).toBeDefined();
  });

  it("persists a bot-scoped skill and renders its files into the box for same-turn use", async () => {
    const { handle, commands } = fileRecordingHandle();
    const { db, inserted } = skillDb();
    const { tools } = buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } });

    const t = tools.save_skill as {
      execute: (i: unknown, o: unknown) => Promise<{ ok: boolean; skillId?: string }>;
    };
    const res = await t.execute(
      {
        name: "Send Lark message",
        description: "post a message to Feishu",
        playbook: "run bin/send.sh with the target",
        files: [{ path: "bin/send.sh", content: "#!/bin/sh\ncurl ...", mode: "755" }],
        secretRefs: ["lark_token"],
      },
      { toolCallId: "s1", messages: [] },
    );

    expect(res.ok).toBe(true);
    expect(res.skillId).toBe("sk-new");
    // persisted as a bot-scoped skill owned by this bot
    expect(inserted[0]).toMatchObject({
      scope: "bot",
      ownerRef: "bot-1",
      name: "Send Lark message",
    });
    expect(inserted[0]!.secretRefs).toEqual(["lark_token"]);
    // stamped into the bot's own `local` plugin — the one editable, exportable bundle
    expect(inserted[0]!.pluginId).toBe("local-plugin-1");
    // file rendered into the box under the new skill's dir
    const write = commands.find((c) => c.includes("base64 -d"));
    expect(write).toContain("/root/.ibot/skills/sk-new/bin/send.sh");
    expect(write).toContain("chmod");
  });

  it("still saves when the bot has no local plugin yet (a null plugin_id, not a failure)", async () => {
    const { handle } = fileRecordingHandle();
    const { db, inserted } = skillDb(null);
    const { tools } = buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } });

    const t = tools.save_skill as {
      execute: (i: unknown, o: unknown) => Promise<{ ok: boolean }>;
    };
    const res = await t.execute(
      { name: "Thing", description: "d", playbook: "p" },
      { toolCallId: "s2", messages: [] },
    );

    expect(res.ok).toBe(true);
    expect(inserted[0]!.pluginId).toBeNull();
  });

  it("saves a file-less skill without any box write", async () => {
    const { handle, commands } = fileRecordingHandle();
    const { db } = skillDb();
    const { tools } = buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } });
    const t = tools.save_skill as { execute: (i: unknown, o: unknown) => Promise<{ ok: boolean }> };

    const res = await t.execute(
      { name: "Just a playbook", description: "no scripts", playbook: "do X then Y" },
      { toolCallId: "s2", messages: [] },
    );
    expect(res.ok).toBe(true);
    expect(commands.filter((c) => c.includes("base64 -d"))).toHaveLength(0);
  });
});

describe("bind_mcp tool", () => {
  // A db stub: records botMcpServers inserts, and answers the vault's secret lookups.
  function mcpDb(secrets: Record<string, string>): {
    db: Database;
    inserted: Record<string, unknown>[];
  } {
    process.env.SECRETS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: "mcp-new" }] };
        },
      }),
      query: {
        bots: { findFirst: async () => ({ ownerId: "owner-1" }) },
        // the bot's `local` plugin — a server the bot bound itself belongs to it
        plugins: { findFirst: async () => ({ id: "local-plugin-1" }) },
        tenantSecrets: {
          findMany: async () =>
            Object.entries(secrets).map(([name, value]) => ({
              name,
              ciphertext: encryptSecret(value),
              kind: "bearer",
              metadata: null,
              ownerType: "bot",
              botId: "bot-1",
              userId: null,
            })),
        },
      },
    } as unknown as Database;
    return { db, inserted };
  }

  const handle: SandboxHandle = {
    id: "row-1",
    provider: "ppio",
    files: fakeSandboxFiles(),
    providerSandboxId: "sbx-1",
    meta: {},
    getHost: (p) => `${p}-sbx-1.example`,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    screenshot: async () => new Uint8Array(),
    detach: () => {},
    destroy: async () => {},
  };

  it("is offered only when a tenant is wired", () => {
    expect(buildSandboxTools(handle).tools.bind_mcp).toBeUndefined();
    const { db } = mcpDb({});
    expect(
      buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } }).tools.bind_mcp,
    ).toBeDefined();
  });

  it("persists a remote server with secret-referencing headers (no plaintext in the stored config)", async () => {
    const { db, inserted } = mcpDb({ lark_token: "s3cr3t" });
    const { tools } = buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } });
    const t = tools.bind_mcp as {
      execute: (
        i: unknown,
        o: unknown,
      ) => Promise<{ ok: boolean; mcpId?: string; missingSecrets?: string[] }>;
    };

    const res = await t.execute(
      {
        name: "lark",
        transport: "http",
        url: "https://lark.example/mcp",
        headers: { Authorization: "Bearer {{secrets.lark_token}}" },
      },
      { toolCallId: "b1", messages: [] },
    );

    expect(res.ok).toBe(true);
    expect(res.mcpId).toBe("mcp-new");
    expect(res.missingSecrets).toBeUndefined();
    // stored row keeps the {{secrets.NAME}} REFERENCE, never the resolved value
    expect(inserted[0]).toMatchObject({
      botId: "bot-1",
      name: "lark",
      transport: "http",
      enabled: true,
      pluginId: "local-plugin-1",
    });
    expect(JSON.stringify(inserted[0]!.headers)).toContain("{{secrets.lark_token}}");
    expect(JSON.stringify(inserted[0]!.headers)).not.toContain("s3cr3t");
  });

  it("warns when a referenced secret is missing (still binds, flags it)", async () => {
    const { db } = mcpDb({}); // no secrets stored
    const { tools } = buildSandboxTools(handle, { tenant: { db, botId: "bot-1" } });
    const t = tools.bind_mcp as {
      execute: (i: unknown, o: unknown) => Promise<{ ok: boolean; missingSecrets?: string[] }>;
    };

    const res = await t.execute(
      {
        name: "lark",
        transport: "http",
        url: "https://lark.example/mcp",
        headers: { Authorization: "Bearer {{secrets.lark_token}}" },
      },
      { toolCallId: "b2", messages: [] },
    );

    expect(res.ok).toBe(true);
    expect(res.missingSecrets).toEqual(["lark_token"]);
  });
});
