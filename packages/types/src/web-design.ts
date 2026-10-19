import { z } from "zod";
import { WebPreviewInput } from "./web-preview.js";

export const WebDesignScenario = z.enum([
  "reading",
  "comparison",
  "tool",
  "portfolio",
  "event",
  "nature",
  "custom",
]);
export const SearchDesignStylesInput = z.object({
  query: z.string().trim().min(1).max(160),
  limit: z.number().int().min(1).max(6).default(3),
});
export const GetDesignStyleInput = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
});
export const ReadWebProjectInput = z.object({
  projectDir: WebPreviewInput.shape.projectDir.optional(),
});

export const WEB_DESIGN_SECTIONS = {
  visualTheme: "1. 视觉主题与氛围",
  colorPalette: "2. 调色板与颜色角色",
  typography: "3. 排版规则",
  components: "4. 组件样式与状态",
  layout: "5. 布局原则",
  elevation: "6. 深度与层级",
  rules: "7. 可行与禁忌",
  responsive: "8. 响应式与交互",
  implementation: "9. 实施提示",
} as const;
const section = z.string().trim().min(8).max(4000);
export const SaveWebDesignInput = z.object({
  projectDir: WebPreviewInput.shape.projectDir,
  /** null creates a new document; existing documents require the version returned by read_web_project. */
  expectedVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  title: WebPreviewInput.shape.title,
  scenario: WebDesignScenario,
  contentPlan: section,
  sections: z.object({
    visualTheme: section,
    colorPalette: section,
    typography: section,
    components: section,
    layout: section,
    elevation: section,
    rules: section,
    responsive: section,
    implementation: section,
  }),
  references: z
    .array(
      z.object({
        url: z
          .string()
          .url()
          .max(2048)
          .refine((v) => /^https:\/\/[^/?#@]+(?:[/?#]|$)/.test(v)),
        adaptation: z.string().trim().min(4).max(1000),
      }),
    )
    .max(3),
  imageAssets: z.string().trim().min(4).max(4000),
  technicalPlan: section,
  verification: section,
});
export type SaveWebDesignInput = z.infer<typeof SaveWebDesignInput>;
