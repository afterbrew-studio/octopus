import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = fileURLToPath(new URL("../../", import.meta.url));
const pageUrl = new URL("../../app/(landing)/docs/cli/ai-agents/page.tsx", import.meta.url).href;

describe("AI agent guide skill availability", () => {
  for (const [name, content] of [
    ["available", "---\nname: octopus\n---\n\n# Fixture skill"],
    ["missing", null],
    ["empty", " \n"],
  ] as const) {
    it(`renders a usable guide when the skill is ${name}`, () => {
      const directory = mkdtempSync(path.join(tmpdir(), "octopus-guide-"));
      try {
        if (content !== null) {
          const skillDirectory = path.join(directory, "public", "skills", "octopus");
          mkdirSync(skillDirectory, { recursive: true });
          writeFileSync(path.join(skillDirectory, "SKILL.md"), content);
        }
        // A child isolates cwd and real filesystem failures from parallel tests.
        const result = Bun.spawnSync([process.execPath, "--eval", `
          import Page from ${JSON.stringify(pageUrl)};
          import { renderToStaticMarkup } from "react-dom/server";
          process.chdir(${JSON.stringify(directory)});
          console.log(renderToStaticMarkup(await Page()));
        `], { cwd: webDirectory });
        expect(result.exitCode).toBe(0);
        const html = result.stdout.toString();
        const available = name === "available";
        expect(html.includes('href="/skills/octopus/SKILL.md"')).toBe(available);
        expect(html.includes("View and copy the skill")).toBe(available);
        expect(html.includes("The skill file is temporarily unavailable")).toBe(!available);
        expect(html).toContain("octp review --staged --no-index --format json");
        if (available) expect(html).toContain("# Fixture skill");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
