import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { canRenderReviewMarkdown } from "./review-markdown-budget";

const parser = unified().use(remarkParse).use(remarkGfm);
const protectedNodes = new Set(["table", "code", "html", "link", "linkReference", "image", "imageReference", "blockquote"]);

/** Keep literal pipes visible without placing them inside consumer-sensitive code spans. */
export function formatReviewInlinePipes(body: string): string {
  if (!body.includes("|") || !body.includes("`")) return body;
  // Optional formatting must not monopolize publication on adversarial Markdown.
  // These conservative admission limits bound the demonstrated parser hot path;
  // unsupported input retains its bytes and the existing downstream size/gates.
  if (!canRenderReviewMarkdown(body)) return body;
  const edits: { start: number; end: number; value: string }[] = [];
  function visit(node: Nodes, prose = false): void {
    if (protectedNodes.has(node.type)) return;
    // Inline HTML nodes can be siblings of code spans, rather than ancestors.
    if ("children" in node && node.children.some(child => child.type === "html")) return;
    if (node.type === "inlineCode") {
      if (!prose) return;
      const { start, end } = node.position ?? {};
      if (start?.offset === undefined || end?.offset === undefined || start.line !== end.line) return;
      const source = body.slice(start.offset, end.offset);
      const ticks = /^`+/.exec(source)?.[0];
      if (!ticks || ticks.length > 80 || !/(?<!\\)\|/.test(source)) return;
      // Use the parser's decoded value: code-span padding is not visible text.
      // Each new nonblank span needs its own padding to retain literal spaces
      // and prevent contained backticks from joining its delimiters.
      const value = node.value.split("|").map(part => part
        ? ticks + (/[^ ]/.test(part) ? ` ${part} ` : part) + ticks
        : "").join("\\|");
      edits.push({ start: start.offset, end: end.offset, value });
      return;
    }
    if ("children" in node) node.children.forEach(child => visit(child, prose || node.type === "paragraph"));
  }
  visit(parser.parse(body));
  // Preserve other bytes and assemble once, rather than recopying the full body
  // for every span in a large review.
  const parts: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    parts.push(body.slice(offset, edit.start), edit.value);
    offset = edit.end;
  }
  parts.push(body.slice(offset));
  return parts.join("");
}
