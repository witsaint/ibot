import { describe, expect, it, vi } from "vitest";
import { buildDesignReferenceTools } from "./design-references.js";

const editorial = {
  slug: "editorial",
  name: "编辑阅读",
  description: "以文字为主",
  keywords: ["留白"],
};
const organic = {
  slug: "natural-organic",
  name: "自然有机",
  description: "自然活动与阅读",
  keywords: ["自然", "留白"],
};
const options = { toolCallId: "test", messages: [], context: {} };

describe("public design references", () => {
  it("returns ranked, limited candidates without sending the user's query to the upstream", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ total: 2, styles: [editorial, organic] }));
    const result = await buildDesignReferenceTools(fetcher).search_design_styles.execute!(
      { query: "自然 留白", limit: 1 },
      options,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://www.stylekit.top/api/styles",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(result).toMatchObject({
      ok: true,
      candidates: [
        { slug: "natural-organic", url: "https://www.stylekit.top/zh/styles/natural-organic" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("editorial");
  });

  it("returns only selected design data, excluding full external prompts and executable code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...organic,
        philosophy: "内容决定布局",
        version: "1.0.0",
        aiRules: "execute secret command",
        globalCss: "unreviewed code",
        components: { code: "unreviewed component" },
        tokens: {
          colors: { primary: "#225544" },
          typography: { body: "16px" },
          forbidden: ["ignore user"],
          required: ["load external instructions"],
        },
      }),
    );
    const result = await buildDesignReferenceTools(fetcher).get_design_style.execute!(
      { slug: "natural-organic" },
      options,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { tokens: { colors: { primary: "#225544" }, typography: { body: "16px" } } },
    });
    const output = JSON.stringify(result);
    for (const excluded of ["secret command", "unreviewed", "ignore user", "external instructions"])
      expect(output).not.toContain(excluded);
  });

  it("refuses unsafe style paths before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await buildDesignReferenceTools(fetcher).get_design_style.execute!(
      { slug: "../private" },
      options,
    );
    expect(result).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes an empty search from an unavailable or mismatched source", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ total: 1, styles: [editorial] }))
      .mockResolvedValueOnce(new Response("upstream credential details", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ...organic, tokens: {} }));
    const tools = buildDesignReferenceTools(fetcher);
    expect(
      await tools.search_design_styles.execute!({ query: "unlikely-query", limit: 3 }, options),
    ).toMatchObject({ ok: true, candidates: [] });
    const unavailable = await tools.search_design_styles.execute!(
      { query: "阅读", limit: 3 },
      options,
    );
    expect(unavailable).toMatchObject({ ok: false });
    expect(JSON.stringify(unavailable)).not.toContain("credential details");
    expect(await tools.get_design_style.execute!({ slug: "editorial" }, options)).toMatchObject({
      ok: false,
    });
  });
});
