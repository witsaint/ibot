import { describe, expect, it } from "vitest";
import { GetDesignStyleInput, ReadWebProjectInput, SearchDesignStylesInput } from "./web-design.js";

describe("web design tool boundaries", () => {
  it("limits search size, reference paths and sandbox project paths", () => {
    expect(SearchDesignStylesInput.parse({ query: " 自然 " })).toEqual({ query: "自然", limit: 3 });
    expect(SearchDesignStylesInput.safeParse({ query: "自然", limit: 7 }).success).toBe(false);
    expect(GetDesignStyleInput.safeParse({ slug: "natural-organic" }).success).toBe(true);
    for (const slug of ["../private", "style?key=secret", "https://other.example"])
      expect(GetDesignStyleInput.safeParse({ slug }).success).toBe(false);
    expect(ReadWebProjectInput.safeParse({}).success).toBe(true);
    expect(ReadWebProjectInput.safeParse({ projectDir: "/root/projects/trails" }).success).toBe(
      true,
    );
    expect(
      ReadWebProjectInput.safeParse({ projectDir: "/root/projects/../../other" }).success,
    ).toBe(false);
  });
});
