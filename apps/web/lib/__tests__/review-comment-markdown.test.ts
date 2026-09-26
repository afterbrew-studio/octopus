import { describe, expect, it } from "bun:test";
import { formatReviewInlinePipes } from "../review-comment-markdown";

const renderedText = (body: string) => Bun.markdown.html(body).replace(/<\/?code>/g, "");

describe("review inline pipe presentation", () => {
  for (const source of [
    "`available|partial|missing|conflicting`", "`string | null`",
    "`|`", "`||`", "`|leading`", "`trailing|`", "`left||right`",
    "``a`|b``", "```a``|`b```", "`` `|` ``", "`  a | b  `",
    "` | `", "`a|  |b`", "`a\t|\tb`", "`a\\|b|c`", "`a\\\\|b|c`",
    "`<T>|**bold**|[label](url)`", "`### Score|Last reviewed commit: abc`",
    "first `a|b` then ``c|d`` and `plain`", "é 😀 `a|b` after UTF-16 pairs",
    "prefix\r\n`a|b`\r\nsuffix", "- nested prose `a|b`",
  ]) {
    it(`preserves rendered characters and is idempotent: ${JSON.stringify(source)}`, () => {
      const output = formatReviewInlinePipes(source);
      expect(output).not.toBe(source);
      expect(renderedText(output)).toBe(renderedText(source));
      expect(formatReviewInlinePipes(output)).toBe(output);
    });
  }

  for (const source of [
    "Plain | prose", "`no pipe`", "`a\\|b`", "`a\\\\|b`", "unclosed `a|b", "### Heading `a|b`",
    "`multiline\nvalue|other`", "\\`literal|tick\\`", "`a|b" + "`".repeat(81),
    "```ts\nconst x = `a|b`;\n```", "~~~text\n`a|b`\n~~~",
    "- nested fence\n  ```ts\n  const x = `a|b`;\n  ```",
    "    const x = `a|b`;", "\tconst x = `a|b`;", "> quote `a|b`",
    "<span>`a|b`</span>", "<!--\n`a|b`\n-->", "[`a|b`](https://example.test)",
    "[`a|b`][ref]\n\n[ref]: https://example.test",
    "| Name | Value |\n| --- | --- |\n| type | `a\\|b` |",
    "Name | Value\n--- | ---\ntype | `a\\|b`",
    "| Category | Score | Notes |\n| --- | --- | --- |\n| **Overall** | **5/5** | `a\\|b` |",
  ]) {
    it(`leaves protected or unsupported markup byte-identical: ${JSON.stringify(source)}`, () => {
      expect(formatReviewInlinePipes(source)).toBe(source);
    });
  }

  it("retains score, footer and fenced evidence while changing only surrounding prose", () => {
    const fixed = "### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| **Overall** | **4/5** | Defect retained |\n\n```mermaid\ngraph TD\nA -->|type `a|b`| B\n```\n\nLast reviewed commit: " + "a".repeat(40);
    const body = "### Summary\nType `a|b`.\n\n" + fixed;
    const output = formatReviewInlinePipes(body);
    expect(output).toEndWith(fixed);
    expect(renderedText(output)).toBe(renderedText(body));
  });
});
