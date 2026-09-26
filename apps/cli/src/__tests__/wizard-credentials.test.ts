import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("wizard entry clears command scope before rendering and uses newly saved approval", async () => {
  const home = await mkdtemp(join(tmpdir(), "octp-wizard-credentials-"));
  try {
    const script = `
      import { mock, expect } from "bun:test";
      import * as ink from "ink";
      import { loadCredentials, loadStoredCredentials, saveCredentials, setCommandCredentials } from "./src/lib/credentials";
      const saved = { baseUrl: "http://localhost", token: "stored", orgId: "stored", orgSlug: "stored", orgName: "Stored", approvedAt: "2026-09-12" };
      const approved = { ...saved, token: "beta", orgId: "beta" };
      const active = { ...saved, token: "alpha", orgId: "alpha" };
      await saveCredentials(saved);
      let renders = 0;
      mock.module("ink", () => ({ ...ink, render: () => {
        renders++;
        return { waitUntilExit: async () => {
          expect(await loadCredentials()).toEqual(saved);
          expect(await loadStoredCredentials()).toEqual(saved);
          await saveCredentials(approved);
          expect(await loadCredentials()).toEqual(approved);
        } };
      } }));
      const { renderWizard } = await import("./src/OnboardWizard");
      for (const reset of [false, true]) {
        await saveCredentials(saved);
        setCommandCredentials(active);
        expect(await loadCredentials()).toEqual(active);
        await renderWizard(reset);
        expect(await loadStoredCredentials()).toEqual(approved);
      }
      expect(renders).toBe(2);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, OCTOPUS_HOME: home },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: out + err }).toEqual({ code: 0, output: "" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
