import { z } from "zod";
import { WebPreviewInput } from "./web-preview.js";

/** Image assets belong to one sandbox project; authentication is provided by the server. */
export const GenerateWebImageInput = z.object({
  projectDir: WebPreviewInput.shape.projectDir,
  purpose: z.enum(["icon", "image"]),
  prompt: z.string().trim().min(10).max(10000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high"]).default("low"),
});
export type GenerateWebImageInput = z.infer<typeof GenerateWebImageInput>;
