import { describe, expect, it, vi } from "vitest";
import { fakeSandboxFiles, type SandboxHandle } from "@i-bot/core";
import { type SaveWebDesignInput, WEB_DESIGN_SECTIONS } from "@i-bot/types";
import { buildWebDesignTools } from "./web-design.js";

const projectDir = "/root/projects/trails";
const input: SaveWebDesignInput = {
  projectDir,
  expectedVersion: null,
  title: "徒步路线",
  scenario: "nature",
  contentPlan: "展示示例徒步路线，首屏说明用途，之后提供可筛选路线和详情。",
  sections: {
    visualTheme: "自然、清晰、留白，让路线信息易于阅读。",
    colorPalette: "背景 #ffffff，正文 #222222；代码集中定义 CSS 变量。",
    typography: "中文系统字体，正文 16px、行高 1.6；标题按内容换行。",
    components: "筛选按钮有选中与键盘焦点；详情显示路线信息。",
    layout: "首屏概述，之后路线列表，最大宽度 1080px。",
    elevation: "卡片使用细边框，详情弹层在内容上方。",
    rules: "示例数据明确标注，不伪造真实活动或评价。",
    responsive: "手机单列，桌面多列，按钮触控目标至少 44px。",
    implementation: "先读 design.md，修改 src/styles.css 中的变量保持一致。",
  },
  references: [],
  imageAssets: "现有山与路径图标，生成图片不作为真实活动证据。",
  technicalPlan: "React + Vite；npm run dev -- --host 0.0.0.0，端口 5173。",
  verification: "未进行浏览器验证；完成页面后检查手机与桌面和筛选操作。",
};
const options = { toolCallId: "test", messages: [], context: {} };
const preview = {
  title: "徒步",
  projectDir,
  sandboxId: "owned",
  port: 5173,
  url: "https://5173-owned.example/",
};
function setup(seed?: Record<string, string>) {
  const files = fakeSandboxFiles(seed);
  const handle = { id: "owned", files } as unknown as SandboxHandle;
  const tools = buildWebDesignTools(handle, [
    preview,
    { ...preview, sandboxId: "old", projectDir: "/root/projects/old" },
  ]);
  return { files, tools };
}

describe("scoped project design document", () => {
  it("lists actual projects, filters stray entries, and attaches only current sandbox previews", async () => {
    const { files, tools } = setup();
    expect(await tools.read_web_project.execute!({}, options)).toEqual({ ok: true, projects: [] });
    await Promise.all(
      [projectDir, "/root/projects/old", "/root/projects/invalid name"].map((dir) =>
        files.makeDir(dir),
      ),
    );
    await files.write("/root/projects/note.txt", "not a project");
    expect(await tools.read_web_project.execute!({}, options)).toEqual({
      ok: true,
      projects: [{ projectDir: "/root/projects/old" }, { projectDir, preview }],
    });
  });

  it("writes all nine concrete sections and only allows updates from the current version", async () => {
    const { files, tools } = setup();
    await files.makeDir(projectDir);
    expect(await tools.read_web_project.execute!({ projectDir }, options)).toMatchObject({
      ok: true,
      document: null,
      version: null,
    });
    const saved = await tools.save_web_design.execute!(input, options);
    expect(saved).toMatchObject({ ok: true, filePath: `${projectDir}/design.md`, sections: 9 });
    const document = await files.readText(`${projectDir}/design.md`);
    for (const heading of Object.values(WEB_DESIGN_SECTIONS))
      expect(document).toContain(`## ${heading}`);
    expect(document).toContain("未进行浏览器验证");
    expect(await tools.save_web_design.execute!(input, options)).toMatchObject({ ok: false });
    const read = await tools.read_web_project.execute!({ projectDir }, options);
    if (!("version" in read)) throw new Error("Expected current document");
    await files.write(`${projectDir}/design.md`, `${document}\n用户的最新修改`);
    expect(
      await tools.save_web_design.execute!({ ...input, expectedVersion: read.version }, options),
    ).toMatchObject({ ok: false });
    expect(await files.readText(`${projectDir}/design.md`)).toContain("用户的最新修改");
    const latest = await tools.read_web_project.execute!({ projectDir }, options);
    if (!("version" in latest)) throw new Error("Expected latest document");
    expect(
      await tools.save_web_design.execute!(
        {
          ...input,
          expectedVersion: latest.version,
          contentPlan: `${input.contentPlan} 按最新要求保留示例标识。`,
        },
        options,
      ),
    ).toMatchObject({ ok: true });
  });

  it("does not create missing projects or touch unsafe paths or incomplete documents", async () => {
    const { files, tools } = setup();
    expect(await tools.save_web_design.execute!(input, options)).toMatchObject({ ok: false });
    expect(files.store.size).toBe(0);
    const exists = vi.spyOn(files, "exists");
    expect(
      await tools.read_web_project.execute!({ projectDir: "/root/projects/../other" }, options),
    ).toMatchObject({ ok: false });
    const { responsive: _responsive, ...sections } = input.sections;
    expect(
      await tools.save_web_design.execute!({ ...input, sections } as SaveWebDesignInput, options),
    ).toMatchObject({ ok: false });
    expect(exists).not.toHaveBeenCalled();
  });

  it("reports connection failures instead of pretending that there are no projects", async () => {
    const { files, tools } = setup();
    vi.spyOn(files, "exists").mockRejectedValue(new Error("private connection information"));
    const result = await tools.read_web_project.execute!({}, options);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private connection information");
  });
});
