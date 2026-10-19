import { createHash } from "node:crypto";
import type { SandboxHandle } from "@i-bot/core";
import {
  ReadWebProjectInput,
  SaveWebDesignInput,
  WEB_DESIGN_SECTIONS,
  type WebPreview,
  type WebProjectRuntime,
} from "@i-bot/types";
import { tool, type Tool } from "ai";
import type { z } from "zod";
import { readWebProjectRuntime } from "./web-project.js";

const versionOf = (content: string) => createHash("sha256").update(content).digest("hex");
type ReadResult =
  | {
      ok: true;
      projects: {
        projectDir: string;
        runtime?: WebProjectRuntime;
        preview?: WebPreview;
      }[];
    }
  | {
      ok: true;
      projectDir: string;
      document: string | null;
      version: string | null;
      preview?: WebPreview;
      runtime?: WebProjectRuntime;
    }
  | { ok: false; error: string };
type SaveResult =
  | { ok: true; filePath: string; version: string; sections: number }
  | { ok: false; error: string };

/** One human-readable project document; the structured input makes its required range explicit. */
export function renderWebDesign(input: SaveWebDesignInput): string {
  const sections = Object.entries(WEB_DESIGN_SECTIONS).map(
    ([key, heading]) =>
      `## ${heading}\n\n${input.sections[key as keyof typeof WEB_DESIGN_SECTIONS]}`,
  );
  const sources = input.references.length
    ? input.references.map((ref) => `- ${ref.url}\n  采用与调整：${ref.adaptation}`).join("\n")
    : "未采用外部设计规范，按本项目内容自主设计。";
  return (
    [
      `# ${input.title.replace(/[\r\n]+/g, " ")} · design.md`,
      `## 目标、内容与事实\n\n场景方向：${input.scenario}\n\n${input.contentPlan}`,
      ...sections,
      `## 参考来源与调整\n\n${sources}`,
      `## 图像与项目图标\n\n${input.imageAssets}`,
      `## 技术与功能\n\n${input.technicalPlan}`,
      `## 验证与待办\n\n${input.verification}`,
    ].join("\n\n") + "\n"
  );
}

/** Reads and writes only the bound bot's sandbox project directories. */
export function buildWebDesignTools(
  handle: SandboxHandle,
  previews: readonly WebPreview[] = [],
): {
  read_web_project: Tool<z.infer<typeof ReadWebProjectInput>, ReadResult>;
  save_web_design: Tool<SaveWebDesignInput, SaveResult>;
} {
  const previewFor = (projectDir: string) =>
    previews.find((p) => p.sandboxId === handle.id && p.projectDir === projectDir);
  return {
    read_web_project: tool({
      description:
        "Inspect web projects in this bot's sandbox. Omit projectDir to list /root/projects; provide it to read that project's design.md, current version and registered preview. Before modifying an existing design, read it here. No projects means initialize a fresh project first.",
      inputSchema: ReadWebProjectInput,
      async execute(input): Promise<ReadResult> {
        const parsed = ReadWebProjectInput.safeParse(input);
        if (!parsed.success) return { ok: false, error: "Invalid project directory" };
        try {
          if (!parsed.data.projectDir) {
            if (!(await handle.files.exists("/root/projects"))) return { ok: true, projects: [] };
            const entries = await handle.files.list("/root/projects", { depth: 1 });
            const projects = await Promise.all(
              entries
                .filter(
                  (entry) =>
                    entry.type === "dir" && /^\/root\/projects\/[A-Za-z0-9_-]+$/.test(entry.path),
                )
                .slice(0, 50)
                .map(async (entry) => {
                  const runtime = await readWebProjectRuntime(handle, entry.path);
                  return {
                    projectDir: entry.path,
                    ...(runtime ? { runtime } : {}),
                    ...(previewFor(entry.path) ? { preview: previewFor(entry.path) } : {}),
                  };
                }),
            );
            return { ok: true, projects };
          }
          const projectDir = parsed.data.projectDir;
          if (!(await handle.files.exists(projectDir)))
            return { ok: false, error: "Project directory does not exist" };
          const filePath = `${projectDir}/design.md`;
          const document = (await handle.files.exists(filePath))
            ? await handle.files.readText(filePath)
            : null;
          if (document && document.length > 64000)
            return {
              ok: false,
              error:
                "Existing design.md is too large for this tool. Read it through run_command and keep edits focused",
            };
          const runtime = await readWebProjectRuntime(handle, projectDir);
          return {
            ok: true,
            projectDir,
            document,
            version: document === null ? null : versionOf(document),
            ...(runtime ? { runtime } : {}),
            ...(previewFor(projectDir) ? { preview: previewFor(projectDir) } : {}),
          };
        } catch {
          return {
            ok: false,
            error:
              "Could not inspect the sandbox project. Check the sandbox connection before assuming the project is missing",
          };
        }
      },
    }),
    save_web_design: tool({
      description:
        "Create or update the project's independent design.md with nine required design sections, actual content, source adaptations, images, technical commands and verification status. Create the project directory first. For updates pass the expectedVersion from read_web_project and preserve existing decisions; null is only for a document that does not exist. Unperformed checks must say unverified, not passed.",
      inputSchema: SaveWebDesignInput,
      async execute(input): Promise<SaveResult> {
        const parsed = SaveWebDesignInput.safeParse(input);
        if (!parsed.success)
          return {
            ok: false,
            error:
              "Design needs all nine sections, content, images, technical plan and verification status",
          };
        try {
          const value = parsed.data;
          if (!(await handle.files.exists(value.projectDir)))
            return { ok: false, error: "Initialize the project directory first" };
          const filePath = `${value.projectDir}/design.md`;
          const existing = (await handle.files.exists(filePath))
            ? await handle.files.readText(filePath)
            : null;
          const actualVersion = existing === null ? null : versionOf(existing);
          if (value.expectedVersion !== actualVersion)
            return {
              ok: false,
              error:
                "design.md has changed or already exists. Read the current project document before updating it",
            };
          const document = renderWebDesign(value);
          if (document.length > 64000)
            return { ok: false, error: "Keep the project design.md under 64000 characters" };
          await handle.files.write(filePath, document);
          return {
            ok: true,
            filePath,
            version: versionOf(document),
            sections: Object.keys(WEB_DESIGN_SECTIONS).length,
          };
        } catch {
          return {
            ok: false,
            error:
              "Could not save project design.md. Check the sandbox connection and retain the current project",
          };
        }
      },
    }),
  };
}
