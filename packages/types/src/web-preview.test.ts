import { describe, expect, it } from "vitest";
import { WebPreviewInput, webPreviewsFromMessages } from "./web-preview.js";
const preview = {
  title: "路线",
  projectDir: "/root/projects/trails",
  port: 5173,
  sandboxId: "box-a",
  url: "https://5173-box-a.sandbox.example/",
};
const part = (value: unknown, state = "output-available") => ({
  type: "tool-preview_web",
  state,
  output: { ok: true, preview: value },
});
describe("web preview references", () => {
  it("limits ports and project paths", () => {
    for (const port of [22, 5900, 5999, 6080, 9222, 49983])
      expect(WebPreviewInput.safeParse({ ...preview, port }).success).toBe(false);
    for (const projectDir of [
      "/root",
      "/root/projects/../private",
      "/tmp/project",
      "/root/projects/a/../../b",
    ])
      expect(WebPreviewInput.safeParse({ ...preview, projectDir }).success).toBe(false);
    expect(WebPreviewInput.safeParse(preview).success).toBe(true);
    expect(
      WebPreviewInput.safeParse({ ...preview, iconPath: "/assets/site-icon.png" }).success,
    ).toBe(true);
    for (const iconPath of [
      "https://other.example/icon.png",
      "/assets/../private.png",
      "/assets/icon.svg",
      "/assets/icon.png?token=secret",
    ]) {
      expect(WebPreviewInput.safeParse({ ...preview, iconPath }).success).toBe(false);
    }
  });
  it("takes successful assistant outputs, never user text or incomplete calls", () => {
    expect(
      webPreviewsFromMessages([
        { role: "user", parts: [part(preview)] },
        {
          role: "assistant",
          parts: [
            part(preview, "input-available"),
            part({ ...preview, url: "javascript:alert(1)" }),
            { type: "text", text: preview.url },
          ],
        },
      ]),
    ).toEqual([]);
    expect(webPreviewsFromMessages([{ role: "assistant", parts: [part(preview)] }])).toEqual([
      preview,
    ]);
  });
  it("keeps multiple projects and replaces the latest URL for one project", () => {
    const other = { ...preview, projectDir: "/root/projects/other", title: "另一个" };
    const changed = { ...preview, port: 5174, url: "https://5174-box-a.sandbox.example/" };
    expect(
      webPreviewsFromMessages([
        { role: "assistant", parts: [part(preview), part(other), part(changed)] },
      ]),
    ).toEqual([other, changed]);
  });
});
