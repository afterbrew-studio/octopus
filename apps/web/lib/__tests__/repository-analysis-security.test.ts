import { describe, expect, it } from "bun:test";

describe("repository analysis markdown boundary", () => {
  it("uses the raw-HTML-disabled markdown renderer and has no HTML injection sink", async () => {
    const component = await Bun.file(
      new URL("../../components/repository-analysis-markdown.tsx", import.meta.url),
    ).text();
    const consumer = await Bun.file(
      new URL(
        "../../app/(app)/repositories/repositories-content.tsx",
        import.meta.url,
      ),
    ).text();

    expect(component).toContain("skipHtml");
    expect(component).not.toContain("dangerouslySetInnerHTML");
    expect(consumer).not.toContain("dangerouslySetInnerHTML");
  });
});
