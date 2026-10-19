import { z } from "zod";

/** App ports exclude the desktop transport; envd/CDP/MCP are outside this range. */
export const WebPreviewInput = z.object({
  title: z.string().trim().min(1).max(80),
  projectDir: z.string().regex(/^\/root\/projects\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  /** Public app asset, relative to the verified service; never an arbitrary remote image URL. */
  iconPath: z
    .string()
    .regex(/^\/assets\/[A-Za-z0-9_-]+\.png$/)
    .optional(),
  port: z
    .number()
    .int()
    .min(3000)
    .max(8999)
    .refine(
      (port) => port !== 6080 && (port < 5900 || port > 5999),
      "Use an application port, not a desktop port",
    ),
});
export type WebPreviewInput = z.infer<typeof WebPreviewInput>;
export const WebPreview = WebPreviewInput.extend({
  sandboxId: z.string().min(1),
  url: z
    .string()
    .url()
    .refine((url) => {
      return /^https:\/\/[^/?#@]+(?:[/?#]|$)/.test(url);
    }, "Use an HTTPS preview URL without credentials"),
});
export type WebPreview = z.infer<typeof WebPreview>;

/** The successful tool output is the persisted canonical project reference. Never infer URLs from prose. */
export function webPreviewsFromMessages(
  messages: readonly { role: string; parts: readonly unknown[] }[],
): WebPreview[] {
  const projects = new Map<string, WebPreview>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const raw of message.parts) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as {
        type?: string;
        toolName?: string;
        state?: string;
        output?: { ok?: boolean; preview?: unknown };
      };
      if (
        part.type !== "tool-preview_web" &&
        !(part.type === "dynamic-tool" && part.toolName === "preview_web")
      )
        continue;
      if (part.state !== "output-available" || part.output?.ok !== true) continue;
      const parsed = WebPreview.safeParse(part.output.preview);
      if (!parsed.success) continue;
      const key = `${parsed.data.sandboxId}:${parsed.data.projectDir}`;
      projects.delete(key);
      projects.set(key, parsed.data);
    }
  }
  return [...projects.values()];
}
