import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { beforeEach, expect, it, vi } from "vitest";
import { verifyWebhook } from "./protocol.js";
const fixtures = vi.hoisted(() => ({
  answers: [{ address: "8.8.8.8", family: 4 }],
  status: 204,
  redirect: false,
}));
const seen: { options?: RequestOptions; body?: string; requests: number } = { requests: 0 };
vi.mock("node:dns/promises", () => ({ lookup: async () => fixtures.answers }));
vi.mock("node:https", () => ({
  request: (_url: URL, options: RequestOptions, callback: (res: unknown) => void) => {
    seen.options = options;
    seen.requests++;
    const req = new EventEmitter() as EventEmitter & {
      end: (body: string) => void;
      destroy: (error?: Error) => void;
    };
    req.destroy = (error) => {
      if (error) req.emit("error", error);
      req.emit("close");
    };
    req.end = (body) => {
      seen.body = body;
      queueMicrotask(() => {
        callback({ statusCode: fixtures.status, destroy: () => {} });
        req.emit("close");
      });
    };
    return req;
  },
}));
const { sendCallback } = await import("./delivery.js");
beforeEach(() => {
  fixtures.answers = [{ address: "8.8.8.8", family: 4 }];
  fixtures.status = 204;
  seen.requests = 0;
});
it("pins both single-address and all-address lookups and sends a verifiable signature", async () => {
  await sendCallback(
    "https://company.example/events",
    "fixture-secret",
    "run-1",
    '{"status":"succeeded"}',
  );
  const single = vi.fn();
  seen.options!.lookup!("company.example", {}, single);
  expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  const all = vi.fn();
  seen.options!.lookup!("company.example", { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  const headers = new Headers(seen.options!.headers as Record<string, string>);
  expect(verifyWebhook("fixture-secret", headers, seen.body!)).toBe(true);
});
it("refuses mixed public/private DNS and IPv4-compatible IPv6 without a request", async () => {
  fixtures.answers = [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await expect(
    sendCallback("https://company.example/events", "fixture", "run-1", "{}"),
  ).rejects.toThrow("内部网络");
  await expect(sendCallback("https://[::7f00:1]/events", "fixture", "run-1", "{}")).rejects.toThrow(
    "内部网络",
  );
  expect(seen.requests).toBe(0);
});
it("rejects redirects so the target cannot switch to an internal address", async () => {
  fixtures.status = 302;
  await expect(
    sendCallback("https://company.example/events", "fixture", "run-1", "{}"),
  ).rejects.toThrow("HTTP 302");
  expect(seen.requests).toBe(1);
});
