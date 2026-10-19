import { z } from "zod";
import { WebPreviewInput } from "./web-preview.js";

export const PrepareWebProjectInput = z.object({
  title: WebPreviewInput.shape.title,
  projectDir: WebPreviewInput.shape.projectDir.optional(),
  framework: z.enum(["react-vite", "nextjs"]).default("react-vite"),
  port: WebPreviewInput.shape.port.optional(),
});
export type PrepareWebProjectInput = z.infer<typeof PrepareWebProjectInput>;

/** Project-local startup configuration, independent of preview message records. */
export const WebProjectRuntime = PrepareWebProjectInput.extend({
  projectDir: WebPreviewInput.shape.projectDir,
  port: WebPreviewInput.shape.port,
});
export type WebProjectRuntime = z.infer<typeof WebProjectRuntime>;

/** Optional presentation and port values can be resolved from a prepared project. */
export const PreviewWebInput = WebPreviewInput.extend({
  title: WebPreviewInput.shape.title.optional(),
  port: WebPreviewInput.shape.port.optional(),
});
export type PreviewWebInput = z.infer<typeof PreviewWebInput>;
