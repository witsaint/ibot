import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSandboxFiles, type SandboxHandle } from "@i-bot/core";
import type { PrepareWebProjectInput } from "@i-bot/types";
import { describe, expect, it, vi } from "vitest";
import {
  buildPrepareWebProjectTool,
  PREPARE_PROJECT_SCRIPT,
  readWebProjectRuntime,
} from "./web-project.js";
const options = { toolCallId: "test", messages: [], context: {} };

describe("automatic web project defaults", () => {
  it("needs only a title and writes a usable starter with an exact host and strict port", async () => {
    const files = fakeSandboxFiles();
    const run = vi.fn<SandboxHandle["run"]>().mockImplementation(async (_command, opts) => {
      const project = { ...JSON.parse(opts!.env!.IBOT_WEB_CONFIG!), port: 5174 };
      await files.write(`${project.projectDir}/.ibot-web.json`, JSON.stringify(project));
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, project }), stderr: "" };
    });
    const handle = {
      files,
      run,
      getHost: (port: number) => `${port}-owned.sandbox.example`,
    } as unknown as SandboxHandle;
    const result = await buildPrepareWebProjectTool(handle).execute!(
      { title: "读书笔记" } as PrepareWebProjectInput,
      options,
    );
    expect(result).toMatchObject({
      ok: true,
      project: { title: "读书笔记", framework: "react-vite", port: 5174 },
    });
    if (!("project" in result)) throw new Error("Expected prepared project");
    const dir = result.project.projectDir;
    expect(dir).toMatch(/^\/root\/projects\/web-[a-f0-9]{8}$/);
    expect(await readWebProjectRuntime(handle, dir)).toEqual(result.project);
    const config = await files.readText(`${dir}/vite.config.ts`);
    expect(config).toContain('host: "0.0.0.0"');
    expect(config).toContain("strictPort: true");
    expect(config).toContain("5174-owned.sandbox.example");
    expect(result).toMatchObject({ previewInput: { projectDir: dir } });
    expect(JSON.parse(await files.readText(`${dir}/package.json`)).scripts.build).toContain(
      "vite build",
    );
  });

  it("does not overwrite an existing project or run unsafe input", async () => {
    const files = fakeSandboxFiles({ "/root/projects/existing/src/App.tsx": "keep this" });
    const run = vi
      .fn<SandboxHandle["run"]>()
      .mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ ok: false, error: "Project directory already exists" }),
        stderr: "",
      });
    const handle = { files, run } as unknown as SandboxHandle;
    const tool = buildPrepareWebProjectTool(handle);
    expect(
      await tool.execute!(
        { title: "新页面", projectDir: "/root/projects/../outside" } as PrepareWebProjectInput,
        options,
      ),
    ).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
    expect(
      await tool.execute!(
        { title: "新页面", projectDir: "/root/projects/existing" } as PrepareWebProjectInput,
        options,
      ),
    ).toMatchObject({ ok: false });
    expect(await files.readText("/root/projects/existing/src/App.tsx")).toBe("keep this");
    expect(files.store.size).toBe(1);
  });

  it("allocates around listening and stopped projects and rejects an occupied explicit port", () => {
    const root = mkdtempSync(join(tmpdir(), "ibot-web-ports-"));
    try {
      const script = PREPARE_PROJECT_SCRIPT.split("\n")
        .slice(1, -1)
        .join("\n")
        .replace(
          "root=pathlib.Path('/root/projects')",
          `root=pathlib.Path(${JSON.stringify(root)})`,
        )
        .replace(
          "project=pathlib.Path(config['projectDir'])",
          "project=root/pathlib.Path(config['projectDir']).name",
        );
      // Hold the first default port if available; a pre-existing listener also counts as occupied.
      const hold =
        "import socket\nholder=socket.socket()\ntry:\n    holder.bind(('0.0.0.0',5173))\nexcept OSError:\n    pass\n";
      const call = (name: string, port?: number) =>
        JSON.parse(
          execFileSync("python3", ["-c", hold + script], {
            env: {
              ...process.env,
              IBOT_WEB_CONFIG: JSON.stringify({
                title: "test",
                framework: "react-vite",
                projectDir: `/root/projects/${name}`,
                ...(port ? { port } : {}),
              }),
            },
            encoding: "utf8",
          }),
        );
      const first = call("first");
      expect(first.ok).toBe(true);
      expect(first.project.port).toBeGreaterThan(5173);
      const second = call("second");
      expect(second.ok).toBe(true);
      expect(second.project.port).not.toBe(first.project.port);
      expect(call("third", first.project.port).ok).toBe(false);
      expect(call("first").ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
