import assert from "node:assert/strict";
import { mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
mock.module("@/app/(app)/settings/integrations/actions", () => ({
  connectForgejo() {}, createForgejoConnector() {}, disconnectForgejo() {}, rotateForgejoConnector() {}, resumeForgejoConnector() {}, syncForgejo() {},
  retryIntegrationSetup() {},
  getIntegrationWebhookDetails() {},
}));
const { ForgejoIntegrationCard } = await import("@/app/(app)/settings/integrations/forgejo-integration-card");
const render = (selfHosted: boolean, data: Parameters<typeof ForgejoIntegrationCard>[0]["data"] = null) =>
  renderToStaticMarkup(<ForgejoIntegrationCard selfHosted={selfHosted} data={data} canManage appUrl="https://octopus.example" />);
const cloud = render(false);
assert.ok(cloud.includes("Public HTTPS instance"));
assert.ok(cloud.includes("Private network connector"));
const local = render(true);
assert.ok(local.includes("Personal access token"));
assert.ok(local.includes("operator-approved LAN/VPN"));
assert.ok(!local.includes('value="connector"'));
assert.ok(!local.includes("A local connector is also available"));
const bound = render(true, { id: "binding", forgejoHost: "https://forgejo.private", username: "bot", connectionMode: "connector", connectorLastSeenAt: null, connectorError: "Reconcile the write" });
for (const control of ["Rotate connector token", "Resume after checking Forgejo", "Disconnect"]) assert.ok(bound.includes(control));
