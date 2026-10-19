import { describe, expect, it, vi } from "vitest";
import type { SandboxHandle } from "@i-bot/core";
import { buildWebImageTool } from "./web-image.js";

const input = {
  projectDir: "/root/projects/test",
  purpose: "icon" as const,
  prompt: "A simple mountain icon",
  quality: "low" as const,
  size: "1024x1024" as const,
};
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function handle() {
  return {
    files: { exists: vi.fn().mockResolvedValue(true), write: vi.fn().mockResolvedValue(undefined) },
    run: vi.fn().mockResolvedValue({ exitCode: 0 }),
  } as unknown as SandboxHandle;
}
async function call(box: SandboxHandle, fetcher: typeof fetch) {
  const t = buildWebImageTool(box, { apiKey: "private-key", botId: "owned-bot" }, fetcher);
  return t.execute!(input, { toolCallId: "test", messages: [], context: {} });
}
describe("web image assets", () => {
  it("keeps authentication on the server and writes only image bytes to the project", async () => {
    const box = handle();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          images: ["https://cos-output-image.ppinfra.com/icon.png?signed=temporary"],
        }),
      )
      .mockResolvedValueOnce(new Response(png));
    const result = await call(box, fetcher);
    expect(result).toMatchObject({ ok: true, mediaType: "image/png", size: 8 });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer private-key",
      "Content-Type": "application/json",
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(JSON.stringify(result)).not.toContain("temporary");
    expect(box.files.write).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/icon-.*\.png\.b64$/),
      Buffer.from(png).toString("base64"),
    );
    expect(box.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: {
          IBOT_IMAGE_PATH: expect.stringMatching(
            /^\/root\/projects\/test\/public\/assets\/icon-.*\.png$/,
          ),
          IBOT_IMAGE_SOURCE: expect.stringMatching(/^\/tmp\/icon-.*\.png\.b64$/),
        },
      }),
    );
  });
  it("does not generate before the owned project exists", async () => {
    const box = handle();
    vi.mocked(box.files.exists).mockResolvedValue(false);
    const fetcher = vi.fn<typeof fetch>();
    expect(await call(box, fetcher)).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a response URL pointing to an internal host and never writes an asset", async () => {
    const box = handle();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ images: ["https://127.0.0.1/private"] }));
    expect(await call(box, fetcher)).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(box.run).not.toHaveBeenCalled();
  });
  it("does not disclose provider errors or save non-PNG responses", async () => {
    const box = handle();
    expect(
      await call(box, vi.fn<typeof fetch>().mockRejectedValue(new Error("private-key"))),
    ).toEqual({ ok: false, error: expect.not.stringContaining("private-key") });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ images: ["https://cos-output-image.ppinfra.com/icon.png"] }),
      )
      .mockResolvedValueOnce(new Response("not an image"));
    expect(await call(box, fetcher)).toMatchObject({ ok: false });
    expect(box.run).not.toHaveBeenCalled();
  });
});
