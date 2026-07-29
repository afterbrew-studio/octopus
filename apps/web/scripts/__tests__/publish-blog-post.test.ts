import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../publish-blog-post";

describe("parseFrontmatter", () => {
  it("parses scalar fields, an inline tags array, and the body", () => {
    const raw = `---
title: Hello World
slug: hello-world
tags: [Claude, Models, Code Review]
---

First paragraph.

## A heading

Second paragraph.`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.title).toBe("Hello World");
    expect(data.slug).toBe("hello-world");
    expect(data.tags).toEqual(["Claude", "Models", "Code Review"]);
    expect(content.startsWith("First paragraph.")).toBe(true);
    expect(content).toContain("## A heading");
    expect(content).not.toContain("---");
  });

  it("returns the whole text as content when there is no frontmatter", () => {
    const { data, content } = parseFrontmatter("Just a body, no frontmatter.");
    expect(data).toEqual({});
    expect(content).toBe("Just a body, no frontmatter.");
  });
});
