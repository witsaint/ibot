import { describe, expect, it, vi } from "vitest";
import { fakeSandboxFiles, type SandboxHandle } from "@i-bot/core";
import { buildWebPreviewTool } from "./web-preview.js";
const input = { title: "测试", projectDir: "/root/projects/test", port: 5173 };
const handle = {
  id: "owned-box",
  getHost: (port: number) => `${port}-owned-box.sandbox.example`,
} as SandboxHandle;
async function call(fetcher: typeof fetch, value: unknown = input) {
  const t = buildWebPreviewTool(handle, fetcher);
  return t.execute!(value as typeof input, { toolCallId: "test", messages: [], context: {} });
}
describe("sandbox web preview", () => {
  it("resolves title and port when only the prepared project path is supplied", async () => {
    const files = fakeSandboxFiles({
      [`${input.projectDir}/.ibot-web.json`]: JSON.stringify({ ...input, framework: "react-vite" }),
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      );
    const t = buildWebPreviewTool({ ...handle, files }, fetcher);
    expect(
      await t.execute!(
        { projectDir: input.projectDir },
        { toolCallId: "test", messages: [], context: {} },
      ),
    ).toEqual({
      ok: true,
      preview: { ...input, sandboxId: "owned-box", url: "https://5173-owned-box.sandbox.example/" },
    });
  });
  it("derives its host from the bound handle and verifies HTML", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      );
    const result = await call(fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://5173-owned-box.sandbox.example/",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(result).toEqual({
      ok: true,
      preview: { ...input, sandboxId: "owned-box", url: "https://5173-owned-box.sandbox.example/" },
    });
  });
  it("refuses reserved ports without issuing a network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await call(fetcher, { ...input, port: 49983 })).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not register unreachable, redirected or non-HTML services", async () => {
    await Promise.all(
      [
        new Response("blocked", { status: 403 }),
        new Response(null, { status: 302, headers: { location: "https://other.example" } }),
        new Response("{}", { headers: { "content-type": "application/json" } }),
      ].map(async (response) => {
        expect(await call(vi.fn<typeof fetch>().mockResolvedValue(response))).toMatchObject({
          ok: false,
        });
      }),
    );
    expect(await call(vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")))).toMatchObject(
      { ok: false },
    );
  });
});
