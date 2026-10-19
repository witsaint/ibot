import type { SandboxHandle } from "@i-bot/core";
import { PreviewWebInput, WebPreviewInput, type WebPreview } from "@i-bot/types";
import { tool, type Tool } from "ai";
import { readWebProjectRuntime } from "./web-project.js";

/** Bound to the owned bot's handle. The model supplies an app port, never a remote host. */
type WebPreviewResult = { ok: true; preview: WebPreview } | { ok: false; error: string };

export function buildWebPreviewTool(
  handle: SandboxHandle,
  fetcher: typeof fetch = fetch,
): Tool<PreviewWebInput, WebPreviewResult> {
  return tool({
    description:
      "Automatically open the running project in the user's right-side preview. After prepare_web_project, only projectDir is needed: title and port come from project configuration. Existing projects without configuration require their actual title and port. Start the app first. Never ask the user to mention this tool or supply a port. The platform verifies HTML and derives the URL.",
    inputSchema: PreviewWebInput,
    async execute(input) {
      const request = PreviewWebInput.safeParse(input);
      if (!request.success)
        return { ok: false as const, error: "Invalid application port or project directory" };
      try {
        const runtime =
          request.data.title && request.data.port
            ? null
            : await readWebProjectRuntime(handle, request.data.projectDir);
        const parsed = WebPreviewInput.safeParse({
          ...request.data,
          title: request.data.title ?? runtime?.title,
          port: request.data.port ?? runtime?.port,
        });
        if (!parsed.success)
          return {
            ok: false as const,
            error:
              "Project has no startup configuration. Inspect its design.md and running process for the actual title and port; do not ask the user for technical parameters",
          };
        const url = `https://${handle.getHost(parsed.data.port)}/`;
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });
        const contentType = response.headers.get("content-type") ?? "";
        await response.body?.cancel();
        if (!response.ok || !contentType.includes("text/html")) {
          return {
            ok: false as const,
            error: `Preview returned HTTP ${response.status} (${contentType}). Check the app process and allowed host ${new URL(url).hostname}.`,
          };
        }
        return { ok: true as const, preview: { ...parsed.data, sandboxId: handle.id, url } };
      } catch (error) {
        return {
          ok: false as const,
          error: `Preview is not reachable. Check the listening port and app logs. ${error instanceof Error ? error.message : "Request failed"}`,
        };
      }
    },
  });
}
