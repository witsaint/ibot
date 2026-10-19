/**
 * Route-level tests for the human-session recording endpoints. The router is mounted alone with a
 * fake ctx (db + sandbox manager) and a stubbed `userId`, so these exercise the real Hono handlers —
 * param routing, the owner-of-bot gate, error-table codes, and the shell commands the recorder is
 * driven with — without a database, a box, or a model. `distillRecording` is mocked (it's the one
 * network call); everything up to it runs for real.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../context.js";

const BOT = "11111111-1111-4111-8111-111111111111";
const OWNER = "user-1";

// ---- mocks -------------------------------------------------------------------------------------
vi.mock("../agent/resolve.js", () => ({
  ownerCredentialFor: vi.fn(async () => ({ apiKey: "k", baseURL: null })),
  loadHistory: vi.fn(async () => []),
}));
vi.mock("../agent/model.js", () => ({ resolveModel: vi.fn(() => ({ fake: "model" })) }));
const distillMock = vi.fn();
/** Set by a test to make distillRecording fail; vitest 5 mis-attributes a rejection that flows
 * through a vi.fn mock as an unhandled error even when the route catches it, so the failing path
 * uses a plain closure instead of the mock. */
let distillImpl: null | ((...a: unknown[]) => Promise<unknown>) = null;
vi.mock("../agent/recording.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  // keep the real shell-driving helpers so the commands they issue are what gets asserted; only the
  // model call is stubbed.
  return {
    ...real,
    distillRecording: (...a: unknown[]) => (distillImpl ? distillImpl(...a) : distillMock(...a)),
  };
});

const { skillsRoutes } = await import("./skills.js");

// ---- fakes -------------------------------------------------------------------------------------
/** A fake SandboxHandle that records every command and answers with canned stdout per pattern. */
function fakeHandle(answers: Array<{ match: RegExp; stdout: string; exitCode?: number }> = []) {
  const commands: string[] = [];
  return {
    commands,
    handle: {
      async run(command: string) {
        commands.push(command);
        const a = answers.find((x) => x.match.test(command));
        return { exitCode: a?.exitCode ?? 0, stdout: a?.stdout ?? "", stderr: "" };
      },
    },
  };
}

/** Rows the fake db "inserted" — reset per test. */
let inserted: Array<Record<string, unknown>> = [];

function app(opts: { handle?: unknown; botOwner?: string | null; noHandle?: boolean }) {
  const a = new Hono<AppBindings>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("ctx", {
      db: {
        query: {
          bots: {
            findFirst: async () =>
              opts.botOwner === null
                ? undefined
                : { id: BOT, ownerId: opts.botOwner ?? OWNER, model: "m" },
          },
        },
        // drizzle's insert(...).values(...).returning() — record what would be written
        insert: () => ({
          values: (row: Record<string, unknown>) => ({
            returning: async () => {
              inserted.push(row);
              return [{ id: "skill-1", ...row }];
            },
          }),
        }),
      },
      sandboxes: {
        getHandle: async () => {
          if (opts.noHandle) throw new Error("not active");
          return opts.handle;
        },
      },
    } as never);
    await next();
  });
  a.route("/skills", skillsRoutes);
  return a;
}

const post = (a: Hono<AppBindings>, path: string) =>
  a.request(`http://x/skills${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

beforeEach(() => {
  distillMock.mockReset();
  distillImpl = null;
  inserted = [];
});

// ---- tests -------------------------------------------------------------------------------------
describe("POST /skills/recording/:botId/:action", () => {
  it("start: wipes any stale session then launches the recorder", async () => {
    const { handle, commands } = fakeHandle([{ match: /start/, stdout: "started pid 1" }]);
    const res = await post(app({ handle }), `/recording/${BOT}/start`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recording: true, frames: 0 });
    // stale-loop kill + fresh dir BEFORE start, then the start itself
    expect(commands[0]).toMatch(/pkill -f 'ibot-recorder.sh _loop'/);
    expect(commands[0]).toMatch(/rm -rf \/tmp\/ibot-rec/);
    expect(commands[1]).toBe("/opt/ibot-recorder.sh start /tmp/ibot-rec");
  });

  it("status: parses the recorder's frame count", async () => {
    const { handle } = fakeHandle([{ match: /status/, stdout: "recording frames=7" }]);
    const res = await post(app({ handle }), `/recording/${BOT}/status`);
    expect(await res.json()).toEqual({ recording: true, frames: 7 });
  });

  it("stop: reports frames captured", async () => {
    const { handle } = fakeHandle([
      { match: /ibot-recorder\.sh stop/, stdout: "stopped frames=12 events=12" },
    ]);
    const res = await post(app({ handle }), `/recording/${BOT}/stop`);
    expect(await res.json()).toEqual({ recording: false, frames: 12 });
  });

  it("refuses a bot the caller does not own (404, same shape as the rest of the router)", async () => {
    const { handle, commands } = fakeHandle();
    const res = await post(app({ handle, botOwner: "someone-else" }), `/recording/${BOT}/start`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
    expect(commands).toHaveLength(0); // never touched the box
  });

  it("409s when the sandbox is not active (no live handle)", async () => {
    const res = await post(app({ noHandle: true }), `/recording/${BOT}/start`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("sandbox_not_ready");
  });

  it("rejects an unknown action at the router (no handler runs)", async () => {
    const { handle, commands } = fakeHandle();
    const res = await post(app({ handle }), `/recording/${BOT}/explode`);
    expect(res.status).toBe(404);
    expect(commands).toHaveLength(0);
  });
});

describe("POST /skills/recording/:botId/analyze", () => {
  const events = [
    { n: 1, t: 200, x: 1, y: 1, win: "LXTerminal", screen: 1, moved: 1, winChanged: 1, key: 0 },
    { n: 2, t: 3000, x: 1, y: 1, win: "LXTerminal", screen: 1, moved: 0, winChanged: 0, key: 0 },
    { n: 3, t: 6000, x: 1, y: 1, win: "Chrome", screen: 1, moved: 0, winChanged: 1, key: 0 },
  ];
  const eventsOut = events.map((e) => JSON.stringify(e)).join("\n") + "\n__META__ 1000 8000";

  it("stops, pulls events + thumbnails, distills, and returns the draft with frame/duration meta", async () => {
    const { handle, commands } = fakeHandle([
      { match: /ibot-recorder\.sh stop/, stdout: "stopped frames=3 events=3" },
      { match: /cat \/tmp\/ibot-rec\/events\.jsonl/, stdout: eventsOut },
      { match: /python3 -W ignore/, stdout: "AAAA\nBBBB\nCCCC\n" },
    ]);
    const draft = { name: "n", description: "d", playbook: "1. x", steps: [], secretRefs: [] };
    distillMock.mockResolvedValue(draft);

    const res = await post(app({ handle }), `/recording/${BOT}/analyze`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft, frames: 3, durationMs: 7000 });

    // stop happened first, then the pull, then the in-box thumbnail transcode of the CHOSEN frames
    expect(commands[0]).toMatch(/ibot-recorder\.sh stop/);
    expect(commands[1]).toMatch(/events\.jsonl/);
    expect(commands[2]).toMatch(/python3 -W ignore/);
    expect(commands[2]).toMatch(/ 0001 0002 0003$/);

    // the distiller got the frames in order with their captions' source events
    const rec = distillMock.mock.calls[0]?.[1] as {
      frames: Array<{ event: { n: number }; jpegBase64: string }>;
    };
    expect(rec.frames.map((f) => f.event.n)).toEqual([1, 2, 3]);
    expect(rec.frames.map((f) => f.jpegBase64)).toEqual(["AAAA", "BBBB", "CCCC"]);
  });

  it("422s on an empty recording (nothing captured) without calling the model", async () => {
    const { handle } = fakeHandle([
      { match: /ibot-recorder\.sh stop/, stdout: "stopped frames=0 events=0" },
      { match: /events\.jsonl/, stdout: "__META__ 1000 1500" },
    ]);
    const res = await post(app({ handle }), `/recording/${BOT}/analyze`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("empty_recording");
    expect(distillMock).not.toHaveBeenCalled();
  });

  it("502s when the model fails, leaving the recording on the box for a retry", async () => {
    const { handle, commands } = fakeHandle([
      { match: /ibot-recorder\.sh stop/, stdout: "stopped frames=3 events=3" },
      { match: /events\.jsonl/, stdout: eventsOut },
      { match: /python3 -W ignore/, stdout: "A\nB\nC\n" },
    ]);
    // Throw when CALLED, not a pre-rejected promise: `mockRejectedValue` creates the rejection at
    // this line, and vitest 5 reports it as unhandled before the route ever awaits it.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    distillImpl = () => Promise.reject(new Error("upstream 500"));
    const res = await post(app({ handle }), `/recording/${BOT}/analyze`);
    err.mockRestore();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("analysis_failed");
    // no discard was issued — the frames stay for a retry
    expect(commands.some((c) => /rm -rf \/tmp\/ibot-rec/.test(c))).toBe(false);
  });
});

describe("POST /skills (publish a recording-distilled draft — the storage step)", () => {
  const draft = {
    name: "Export the monthly billing CSV",
    description: "When the user wants last month's invoice as a file.",
    playbook:
      "1. Open the billing page.\n2. Log in with {{secrets.CONSOLE_PASSWORD}}.\n3. Click Export.",
    steps: [{ note: "Open billing", action: "focus_window" }, { note: "Click Export" }],
    secretRefs: ["CONSOLE_PASSWORD"],
  };
  const publish = (a: Hono<AppBindings>, body: unknown) =>
    a.request("http://x/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores the reviewed draft as a bot-scoped skill with steps and secretRefs intact", async () => {
    const res = await publish(app({}), { botId: BOT, ...draft });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { skill: { id: string; name: string } };
    expect(body.skill.id).toBe("skill-1");
    expect(body.skill.name).toBe(draft.name);
    // exactly one row, scoped to THIS bot, carrying the structured parts the distiller produced
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      scope: "bot",
      ownerRef: BOT,
      name: draft.name,
      playbook: draft.playbook,
      steps: draft.steps,
      secretRefs: ["CONSOLE_PASSWORD"],
    });
  });

  it("refuses to store a skill on a bot the caller does not own — nothing is written", async () => {
    const res = await publish(app({ botOwner: "someone-else" }), { botId: BOT, ...draft });
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a malformed draft (missing playbook) before touching the db", async () => {
    const { playbook: _omit, ...broken } = draft;
    void _omit;
    const res = await publish(app({}), { botId: BOT, ...broken });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    expect(inserted).toHaveLength(0);
  });
});
