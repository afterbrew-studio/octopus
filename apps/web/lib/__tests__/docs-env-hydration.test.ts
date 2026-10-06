import { expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvGenerator } from "@/app/(landing)/docs/self-hosting/env-generator";

it("renders a deterministic environment template without server-generated credentials and disables Copy until ready", async () => {
  const random = spyOn(crypto, "getRandomValues");
  try {
    const first = renderToStaticMarkup(createElement(EnvGenerator));
    const second = renderToStaticMarkup(createElement(EnvGenerator));
    expect(first === second).toBe(true);
    expect(random).not.toHaveBeenCalled();
    expect(/(?:BETTER_AUTH_SECRET|OCTOPUS_DATA_KEY)=[a-f0-9]{64}/.test(first)).toBe(false);
    let copyDisabled: boolean | undefined;
    await new HTMLRewriter().on('button[aria-label="Copy environment configuration"]', {
      element(button) { copyDisabled = button.hasAttribute("disabled"); },
    }).transform(new Response(first)).text();
    expect(copyDisabled).toBe(true);
  } finally {
    random.mockRestore();
  }
});
