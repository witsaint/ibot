/**
 * `:tag[text]{tone=ok}` → an inline chip in assistant prose.
 *
 * This is the lightweight layer of "rich content": a status or label that doesn't warrant an A2UI
 * card (those are for anything interactive or multi-field — see `render_ui`). It rides on
 * remark-directive's generic *text directive* syntax, so it's ordinary markdown to the model and
 * degrades to plain text anywhere the plugin isn't loaded.
 *
 * Security: the directive's children are markdown text nodes, never raw HTML (react-markdown does
 * not enable HTML). `tone` is coerced through an allow-list on the render side (`toChipTone`), so
 * an unknown or malicious value only ever produces a neutral chip. Any OTHER text directive
 * (`:foo[...]`) is neutralised to an inline <span> of its own text — mdast-util-to-hast would
 * otherwise emit a <div> for it, which is invalid inside a paragraph and breaks the line.
 */
import type { Root } from "mdast";
import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { visit } from "unist-util-visit";

/** The one directive name this plugin owns. */
export const TAG_DIRECTIVE = "tag";
/** The element name we hand to react-markdown's `components` map. */
export const TAG_ELEMENT = "ui-chip";

interface TextDirective {
  type: "textDirective";
  name: string;
  attributes?: Record<string, string | null | undefined> | null;
  children: unknown[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/**
 * remark plugin: rewrite `:tag[...]{tone=…}` into a `<ui-chip data-tone="…">` hast element, and
 * any other text directive into a plain inline <span> so it degrades to its text.
 */
export function remarkTags() {
  return (tree: Root) => {
    visit(tree, "textDirective", (node: TextDirective) => {
      if (node.name !== TAG_DIRECTIVE) {
        node.data = { ...node.data, hName: "span", hProperties: {} };
        return;
      }
      const tone = node.attributes?.tone;
      node.data = {
        ...node.data,
        hName: TAG_ELEMENT,
        hProperties: { "data-tone": typeof tone === "string" ? tone : "muted" },
      };
    });
  };
}

/** Props react-markdown hands our custom element: the chip's children and the coerced tone attr. */
export interface TagElementProps {
  children?: ReactNode;
  "data-tone"?: string;
}

/**
 * Build the `components` entry that renders `<ui-chip>`. react-markdown's `Components` type is
 * keyed by HTML tag names, so a custom element has to be widened once here — this is the ONLY
 * place that cast lives; callers just spread the result into their `components` map.
 */
export function tagComponents(render: (props: TagElementProps) => ReactNode): Components {
  return { [TAG_ELEMENT]: render } as unknown as Components;
}
