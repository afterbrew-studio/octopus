"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconGitFork } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { connectForgejo, createForgejoConnector, disconnectForgejo, rotateForgejoConnector, resumeForgejoConnector, syncForgejo } from "./actions";
import { IntegrationSetupPanel } from "./integration-setup-panel";
import type { IntegrationSetupStatus } from "@/lib/integration-setup";

type ForgejoData = {
  id: string;
  forgejoHost: string;
  username: string;
  webhookSecret?: string;
  connectionMode: "direct" | "connector";
  connectorLastSeenAt: string | null;
  connectorError: string | null;
  setupStatus?: IntegrationSetupStatus;
} | null;
type ActionResult = { error?: string; synced?: number; connectorToken?: string };

export function ForgejoIntegrationCard({ data, canManage, selfHosted, appUrl }: {
  data: ForgejoData;
  canManage: boolean;
  selfHosted: boolean;
  appUrl: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [mode, setMode] = useState<"direct" | "connector">(selfHosted ? "direct" : data?.connectionMode ?? "direct");
  const [host, setHost] = useState(data?.forgejoHost ?? "");
  const [token, setToken] = useState("");
  const [connectorToken, setConnectorToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState(appUrl ?? "");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!appUrl) setOrigin(window.location.origin); }, [appUrl]);
  const connector = data?.connectionMode === "connector";
  useEffect(() => {
    if (!connector) return;
    const timer = setInterval(() => { setNow(Date.now()); router.refresh(); }, 10_000);
    return () => clearInterval(timer);
  }, [connector, router]);
  const online = !!data?.connectorLastSeenAt && now - Date.parse(data.connectorLastSeenAt) < 90_000;
  const ready = !!data && (!connector || (online && !!data.username && !data.connectorError));
  const status = !connector ? "Access authorized" : data?.connectorError ? "Paused" : online ? "Connector online" : data?.username ? "Connector offline" : "Waiting for connector";
  const webhookUrl = data && origin ? `${origin.replace(/\/$/, "")}/api/forgejo/webhook/${data.id}` : "";

  function run(action: () => Promise<ActionResult>, success: string, onSuccess?: () => void) {
    if (busy.current) return;
    busy.current = true;
    setError(""); setMessage("");
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) setError(result.error);
        else {
          onSuccess?.();
          if (result.connectorToken) setConnectorToken(result.connectorToken);
          setMessage(result.synced !== undefined ? `${result.synced} repositories synced. Configure each repository’s webhook and enable Auto Review, then open or update a non-draft pull request. Repository preparation happens automatically.` : success);
        }
        router.refresh(); setNow(Date.now());
      } catch { setError("The request failed. Refresh the connection status before retrying."); }
      finally { busy.current = false; }
    });
  }

  return (
    <Card id="forgejo" className="min-w-0 scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <IconGitFork className="size-5 text-orange-500" />
          <CardTitle>Forgejo</CardTitle>
          {data && <Badge variant="outline">{status}</Badge>}
        </div>
        <CardDescription>Review pull requests on your Forgejo instance.</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <p className="text-muted-foreground text-sm">
          {selfHosted
            ? "Self-hosted Octopus can connect directly over HTTPS to public instances or operator-approved LAN/VPN instances."
            : "Connect a public HTTPS instance directly, or run a local connector for a private LAN/VPN instance."}
        </p>
        <a className="text-primary text-sm underline underline-offset-4" href="/docs/integrations#forgejo">Compare the three Forgejo connection options</a>
        {data && <p className="break-all text-sm">{data.username ? `${data.username} · ` : ""}{data.forgejoHost} · {connector ? "Local connector" : "Direct HTTPS"}</p>}
        {data && <IntegrationSetupPanel provider="forgejo" setupStatus={data.setupStatus} canManage={canManage} showRetry={false} />}
        {!canManage ? <p className="text-muted-foreground text-sm">An organization owner or admin can manage this connection.</p> : (
          <>
            {!data && !selfHosted && <fieldset className="space-y-2" disabled={pending}>
              <legend className="mb-2 text-sm font-medium">How should Octopus connect?</legend>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
                <input type="radio" name="forgejo-mode" value="direct" checked={mode === "direct"} onChange={() => setMode("direct")} className="mt-1" />
                <span><span className="block font-medium">{selfHosted ? "Direct HTTPS from self-hosted Octopus" : "Public HTTPS instance"}</span><span className="text-muted-foreground">{selfHosted ? "Your Octopus server reaches Forgejo. Private addresses require an operator allowlist." : "Octopus Cloud reaches Forgejo over the internet."}</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm">
                <input type="radio" name="forgejo-mode" value="connector" checked={mode === "connector"} onChange={() => setMode("connector")} className="mt-1" />
                <span><span className="block font-medium">Private network connector</span><span className="text-muted-foreground">Run a connector beside Forgejo. No public Forgejo URL or inbound ports required.</span></span>
              </label>
            </fieldset>}
            {(!data || !connector) && <details open={!data}>
              <summary className="cursor-pointer text-sm font-medium">{data ? "Replace access token" : mode === "connector" ? "Create a private connector" : "Connect your instance"}</summary>
              <form className="mt-3 space-y-3" onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                run(() => mode === "connector" && !data ? createForgejoConnector(formData) : connectForgejo(formData), "Connector created. Save its token and start the connector, then sync repositories.", () => setToken(""));
              }}>
                <div className="space-y-1.5">
                  <Label htmlFor="forgejo-host">Forgejo instance URL</Label>
                  <Input id="forgejo-host" name="host" type="url" placeholder="https://forgejo.example.com" value={data?.forgejoHost ?? host} onChange={(event) => setHost(event.target.value)} readOnly={!!data || pending} required />
                </div>
                {(mode === "direct" || !!data) ? <>
                  <div className="space-y-1.5">
                    <Label htmlFor="forgejo-token">Personal access token</Label>
                    <Input id="forgejo-token" name="token" type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} readOnly={pending} maxLength={4096} required />
                  </div>
                  <p className="text-muted-foreground text-xs">Use a dedicated Forgejo account with admin access only to the intended repositories. Choose All repositories for the token and the read:user, write:repository and write:issue scopes.</p>
                </> : <p className="text-muted-foreground text-sm">The Forgejo token stays on the connector. Repository content and diffs travel to Octopus and its configured AI providers for indexing and reviews. Both Forgejo and the connector need outbound HTTPS access to Octopus.</p>}
                <p className="text-muted-foreground text-xs">One instance per organization. Only repositories the Forgejo account administers are synced.</p>
                <Button type="submit" disabled={pending}>{pending ? "Working…" : data ? "Replace token and sync" : mode === "connector" ? "Create connector" : "Connect Forgejo"}</Button>
              </form>
            </details>}
            {connectorToken && <div className="space-y-3 rounded-md border p-4">
              <p className="text-sm font-medium">Save this connector token now</p>
              <p className="text-muted-foreground text-sm">It is shown once. Store it as OCTOPUS_CONNECTOR_TOKEN in the connector’s private environment file. Keep your Forgejo personal access token on that machine.</p>
              <Label htmlFor="forgejo-connector-token">Connector token</Label>
              <Input id="forgejo-connector-token" type="password" value={connectorToken} readOnly onFocus={(event) => event.target.select()} />
              <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(connectorToken).then(() => setMessage("Connector token copied."), () => setError("Copy failed. Select and copy the token manually.")); }}>Copy connector token</Button>
            </div>}
            {connector && <div className="space-y-2 rounded-md border p-4">
              <p className="text-sm font-medium">Run the connector on your private network</p>
              <p className="text-muted-foreground text-sm">Set OCTOPUS_URL to {origin.startsWith("https://") ? origin : "your Octopus HTTPS origin"}, FORGEJO_URL to {data.forgejoHost}, and add the connector token and your Forgejo token locally.</p>
              <a className="text-primary text-sm underline underline-offset-4" href="/docs/integrations#forgejo-cloud-private">Docker setup, certificates and troubleshooting</a>
              <p className="text-muted-foreground text-xs">{data.connectorLastSeenAt ? `Last contact: ${new Date(data.connectorLastSeenAt).toLocaleString()}` : "Waiting for the connector’s first authenticated connection."}</p>
              <Button variant="outline" disabled={pending} onClick={() => { router.refresh(); setNow(Date.now()); }}>Refresh status</Button>
              {data.connectorError && <>
                <p role="alert" className="text-destructive text-sm">{data.connectorError} Check comments, reviews and commit statuses in Forgejo before resuming.</p>
                <Button variant="outline" disabled={pending} onClick={() => {
                  if (window.confirm("Have you checked Forgejo for the interrupted write? Resuming allows new reviews; retry a failed review only after checking for an existing result.")) run(() => resumeForgejoConnector(data.id), "Connector resumed. Check the failed review before requesting another run.");
                }}>Resume after checking Forgejo</Button>
              </>}
            </div>}
            {data?.webhookSecret && <div className="space-y-3 rounded-md border p-4">
              <p className="text-sm font-medium">Set up automatic reviews</p>
              <p className="text-muted-foreground text-sm">After syncing repositories, open each repository’s Settings → Webhooks → Add Webhook → Forgejo. Use POST, application/json, and the URL and secret below. Under Trigger on, choose Custom events… and select Modification, Synchronized, and Comments in the Pull request events section. Keep Active checked.</p>
              {connector && <p className="text-muted-foreground text-sm">Forgejo sends this webhook outward to Octopus. The connector has no webhook port.</p>}
              <div className="space-y-1.5"><Label htmlFor="forgejo-webhook-url">Target URL</Label><Input id="forgejo-webhook-url" value={webhookUrl} readOnly onFocus={(event) => event.target.select()} /></div>
              <div className="space-y-1.5"><Label htmlFor="forgejo-webhook-secret">Webhook secret</Label><Input id="forgejo-webhook-secret" value={data.webhookSecret} readOnly onFocus={(event) => event.target.select()} /></div>
              <p className="text-muted-foreground text-xs">Open or update a pull request, or comment <code>@octopus</code> or <code>/octopus</code> to request a review.</p>
            </div>}
            {data && <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={pending || !ready} onClick={() => run(syncForgejo, "Repositories synced.")}>Sync repositories</Button>
              {connector && <Button variant="outline" disabled={pending} onClick={() => {
                if (window.confirm("Rotate this connector’s token? Update the local environment file and recreate the Docker container afterward. The old token will stop working.")) run(() => rotateForgejoConnector(data.id), "Token rotated. Update the environment file and recreate the Docker container, or restart the local connector process.");
              }}>Rotate connector token</Button>}
              <Button variant="outline" disabled={pending} onClick={() => {
                if (window.confirm("Disconnect Forgejo and deactivate its repositories? Review history is kept. Stop any connector, remove Octopus webhooks and revoke its Forgejo token afterward.")) run(disconnectForgejo, "Forgejo disconnected. Stop the connector, remove the webhooks and revoke its Forgejo token.", () => { setConnectorToken(""); setToken(""); });
              }}>Disconnect</Button>
            </div>}
          </>
        )}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        {message && <p role="status" className="text-muted-foreground text-sm">{message}</p>}
      </CardContent>
    </Card>
  );
}
