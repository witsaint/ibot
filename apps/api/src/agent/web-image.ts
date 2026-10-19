import { randomUUID } from "node:crypto";
import type { SandboxHandle } from "@i-bot/core";
import type { Storage } from "@i-bot/storage";
import { GenerateWebImageInput } from "@i-bot/types";
import { tool, type Tool } from "ai";

const ENDPOINT = "https://apiproxy.paigod.work/v3/gpt-image-2-text-to-image";
const MAX_BYTES = 12 * 1024 * 1024;
type Input = GenerateWebImageInput;
type Result =
  | {
      ok: true;
      assetPath: string;
      filePath: string;
      mediaType: "image/png";
      size: number;
      objectKey?: string;
    }
  | { ok: false; error: string };

/** Key stays on the API server; the sandbox receives only the generated project asset. */
export function buildWebImageTool(
  handle: SandboxHandle,
  config: { apiKey: string; botId: string; storage?: Storage | null },
  fetcher: typeof fetch = fetch,
): Tool<Input, Result> {
  return tool({
    description:
      "Generate an icon or illustration through AiProxy GPT Image 2, save its PNG to this sandbox project's public/assets, and return the local asset path. For a tab icon use purpose icon, a square simple silhouette without words or fine details. Pass its assetPath as preview_web.iconPath. The API key is handled by the platform. Generation may take several minutes; on failure continue with a text or CSS fallback.",
    inputSchema: GenerateWebImageInput,
    async execute(input) {
      const parsed = GenerateWebImageInput.safeParse(input);
      if (!parsed.success) return { ok: false, error: "Invalid image request" };
      const { projectDir, purpose, prompt, quality } = parsed.data;
      let stage = "project check";
      try {
        if (!(await handle.files.exists(projectDir)))
          return { ok: false, error: "Create the project directory before generating an image" };
        stage = "generation";
        const response = await fetcher(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            n: 1,
            size: purpose === "icon" ? "1024x1024" : parsed.data.size,
            quality,
            output_format: "png",
            background: "opaque",
          }),
          signal: AbortSignal.timeout(360000),
        });
        if (!response.ok)
          return {
            ok: false,
            error: `Image generation returned HTTP ${response.status}; keep the fallback and check the gateway configuration`,
          };
        const body = (await response.json()) as { images?: unknown[] };
        const source = typeof body.images?.[0] === "string" ? new URL(body.images[0]) : null;
        if (
          !source ||
          source.protocol !== "https:" ||
          source.hostname !== "cos-output-image.ppinfra.com" ||
          source.username ||
          source.password
        ) {
          return { ok: false, error: "Gateway did not return a supported image download URL" };
        }
        stage = "download";
        const image = await fetcher(source, {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        if (
          !image.ok ||
          !image.body ||
          Number(image.headers.get("content-length") ?? 0) > MAX_BYTES
        ) {
          return { ok: false, error: "Generated image download failed or exceeded the size limit" };
        }
        const reader = image.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        /* eslint-disable no-await-in-loop */ // One reader, bounded byte count; reads must be sequential.
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MAX_BYTES) {
            await reader.cancel();
            return { ok: false, error: "Generated image exceeded the size limit" };
          }
          chunks.push(part.value);
        }
        /* eslint-enable no-await-in-loop */
        const bytes = Buffer.concat(chunks);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          return { ok: false, error: "Generated asset is not a PNG" };
        const filename = `${purpose}-${randomUUID()}.png`;
        const assetPath = `/assets/${filename}`;
        const filePath = `${projectDir}/public${assetPath}`;
        // Transfer the payload through the file API; large environment values exceed Linux exec limits.
        const sourcePath = `/tmp/${filename}.b64`;
        stage = "sandbox save";
        await handle.files.write(sourcePath, bytes.toString("base64"));
        const write = await handle.run(
          'python3 -c \'import os,base64,pathlib; p=pathlib.Path(os.environ["IBOT_IMAGE_PATH"]); p.parent.mkdir(parents=True,exist_ok=True); src=pathlib.Path(os.environ["IBOT_IMAGE_SOURCE"]); p.write_bytes(base64.b64decode(src.read_text())); src.unlink()\'',
          {
            timeoutMs: 20000,
            env: { IBOT_IMAGE_PATH: filePath, IBOT_IMAGE_SOURCE: sourcePath },
          },
        );
        if (write.exitCode !== 0)
          return {
            ok: false,
            error: "Image generated but could not be saved to the sandbox project",
          };
        let objectKey: string | undefined;
        if (config.storage) {
          objectKey = `bots/${config.botId}/generated/${filename}`;
          stage = "object storage";
          await config.storage.putObject(objectKey, bytes, "image/png");
        }
        return {
          ok: true,
          assetPath,
          filePath,
          mediaType: "image/png",
          size,
          ...(objectKey ? { objectKey } : {}),
        };
      } catch {
        // Provider errors can contain signed URLs or credentials; never relay their raw text.
        return {
          ok: false,
          error: `Image ${stage} failed. Keep the fallback; do not retry repeatedly`,
        };
      }
    },
  });
}
