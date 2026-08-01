import { describe, expect, it } from "bun:test";
import { formatInlineEmailHtml, safeJsonLd } from "@/lib/html";

describe("email inline markup", () => {
  it("renders untrusted HTML and unsafe link schemes as inert text", () => {
    const html = formatInlineEmailHtml(
      'Hello <img src="x" onerror="alert(1)"> [open](javascript:alert(2))',
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;img");
    expect(html).toContain('href="#"');
  });

  it("preserves the supported safe formatting subset", () => {
    const html = formatInlineEmailHtml(
      "**Bold** [docs](https://example.com?a=1&b=2) and `code`",
    );

    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('href="https://example.com?a=1&amp;b=2"');
    expect(html).toContain(">code</code>");
  });

  it("serializes JSON-LD without an executable script terminator", () => {
    const json = safeJsonLd({ title: "</script><script>alert(1)</script>" });

    expect(json).not.toContain("</script>");
    expect(json).toContain("\\u003c/script\\u003e");
  });
});
