import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const configUrl = new URL("../../next.config.ts", import.meta.url).href;

test("Next preserves release source identity and falls back for local builds", () => {
  const source = "a".repeat(40);
  for (const supplied of [source, "", null]) {
    const child = spawnSync(process.execPath, ["--no-install", "--eval", `
      import { mock } from "bun:test";
      mock.module("dotenv", () => ({ config() {} }));
      mock.module("@sentry/nextjs", () => ({ withSentryConfig: (config) => config }));
      const supplied = ${JSON.stringify(supplied)};
      if (supplied === null) delete process.env.NEXT_PUBLIC_BUILD_ID;
      else process.env.NEXT_PUBLIC_BUILD_ID = supplied;
      Date.now = () => 123456789;
      const { default: config } = await import(${JSON.stringify(configUrl)});
      console.log(JSON.stringify(config.env.NEXT_PUBLIC_BUILD_ID));
    `], { encoding: "utf8", timeout: 10000 });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toBe(supplied || "123456789");
  }
});
