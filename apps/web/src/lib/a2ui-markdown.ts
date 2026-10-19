/**
 * The markdown renderer A2UI's `Text` component uses for its `body` variant.
 *
 * `@a2ui/react`'s Text renders body text through `MarkdownContext` — an async `(text) => html`
 * function the host supplies. With none configured it falls back to the raw string in a div, so a
 * model that writes `**bold**`, a list or a link (as the spec invites) shows the literal syntax.
 * This is that renderer, built on the same remark stack the chat's `<Markdown>` uses (react-markdown
 * is React-output only, so the string pipeline is assembled here directly).
 *
 * Safety: the output is injected via innerHTML by the package, so it MUST be sanitised — the text is
 * model-authored. `remark-rehype` already drops raw HTML (no `allowDangerousHtml`); `rehype-sanitize`
 * with its default (GitHub) schema additionally strips `javascript:` URLs, event handlers and unknown
 * attributes. Links open in a new tab via a delegated click handler in `A2uiPanel` rather than
 * `target=_blank` here (the schema strips `target`, and one listener is cheaper than per-link attrs).
 */
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify);

/** `MarkdownRenderer` shape expected by `@a2ui/react`'s `MarkdownContext`. */
export async function renderA2uiMarkdown(text: string): Promise<string> {
  return String(await processor.process(text));
}
