"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseIntegrationSetupStatus, type IntegrationSetupStatus } from "@/lib/integration-setup";
import { getIntegrationWebhookDetails, retryIntegrationSetup } from "./actions";

type Provider = "github" | "bitbucket" | "gitlab" | "forgejo";

export function IntegrationSetupPanel({ provider, setupStatus, canManage, showRetry = true }: {
  provider: Provider;
  setupStatus?: IntegrationSetupStatus;
  canManage: boolean;
  showRetry?: boolean;
}) {
  const setup = setupStatus ?? parseIntegrationSetupStatus(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ error?: string; message?: string } | null>(null);
  const router = useRouter();
  const needsAttention = setup.sync.status !== "ready" || setup.webhook.status === "failed" ||
    ((provider === "bitbucket" || provider === "gitlab") && setup.webhook.status === "unknown");
  const webhookLabel = provider === "forgejo" ? "Manual setup required"
    : setup.webhook.status === "failed" ? "Needs attention"
    : setup.webhook.status === "ready" ? "Configured"
    : provider === "github" ? "Managed by GitHub App" : "Not checked";

  return (
    <section aria-label="Integration setup" className="space-y-4 rounded-md border p-4">
      <dl className="space-y-3 text-sm">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="font-medium">Repository sync</dt>
          <dd>{setup.sync.status === "ready" ? "Synced" : setup.sync.status === "failed" ? "Needs attention" : "Not checked"}</dd>
        </div>
        {setup.sync.checkedAt && <div className="text-muted-foreground text-xs"><dt className="inline">Last sync check: </dt><dd className="inline"><time dateTime={setup.sync.checkedAt}>{new Date(setup.sync.checkedAt).toISOString().replace("T", " ").slice(0, 16)} UTC</time></dd></div>}
        {setup.sync.error && <div><dt className="sr-only">Repository sync issue</dt><dd className="text-destructive break-words">{setup.sync.error}</dd></div>}
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <dt className="font-medium">Webhook setup</dt>
          <dd>{webhookLabel}</dd>
        </div>
        {setup.webhook.error && <div><dt className="sr-only">Webhook setup issue</dt><dd className="text-destructive break-words">{setup.webhook.error}</dd></div>}
      </dl>
      <p className="text-muted-foreground text-sm">
        {provider === "forgejo"
          ? canManage ? "Add the webhook in each Forgejo repository using the URL and secret below. Syncing repositories does not create webhooks."
            : "Ask an organization owner or admin to add the signed webhook in each Forgejo repository. Syncing repositories does not create webhooks."
          : provider === "github"
            ? "The GitHub App manages webhooks. Repository sync does not confirm that a pull request event has reached Octopus."
            : "Retry setup checks repository access and configures missing Octopus webhooks. A configured webhook still needs a pull request event to confirm delivery."}
      </p>
      <p className="text-muted-foreground text-sm">In Repositories, choose a repository and enable Auto Review, then open or update a non-draft pull request. Octopus prepares the repository automatically when the review starts. Follow your first review from the Dashboard.</p>
      <div className="flex flex-wrap gap-2">
        {canManage && showRetry && <Button variant="outline" size="sm" disabled={pending} onClick={() => {
          setResult(null);
          startTransition(async () => {
            try {
              const response = await retryIntegrationSetup(provider);
              setResult(response.error ? { error: response.error } : { message: "Setup checked. Review the status above before starting your first review." });
            } catch {
              setResult({ error: "Setup could not be checked. Try again in a moment." });
            }
            router.refresh();
          });
        }}>{pending ? "Checking setup…" : needsAttention ? "Retry setup" : "Check setup"}</Button>}
        <Button variant="outline" size="sm" asChild><Link href="/repositories">View repositories</Link></Button>
        <Button variant="ghost" size="sm" asChild><Link href={`/docs/integrations#${provider}`}>Setup guide</Link></Button>
      </div>
      {!canManage && <p className="text-muted-foreground text-sm">An organization owner or admin can retry setup.</p>}
      {canManage && (provider === "bitbucket" || provider === "gitlab") && <WebhookRecoveryDetails provider={provider} />}
      {result?.error && <p role="alert" className="text-destructive text-sm">{result.error}</p>}
      {result?.message && <p role="status" className="text-muted-foreground text-sm">{result.message}</p>}
    </section>
  );
}

function WebhookRecoveryDetails({ provider }: { provider: "bitbucket" | "gitlab" }) {
  const [pending, startTransition] = useTransition();
  const [details, setDetails] = useState<Awaited<ReturnType<typeof getIntegrationWebhookDetails>>["details"]>();
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; message?: string } | null>(null);

  return <details className="border-t pt-3" onToggle={event => {
    if (!event.currentTarget.open) { setDetails(undefined); setRevealed(false); setFeedback(null); }
  }}>
    <summary className="cursor-pointer text-sm font-medium">Repair an existing webhook</summary>
    <div className="mt-3 space-y-3 text-sm">
      <p>Only edit a webhook you can identify as belonging to this Octopus organization from your saved hook ID or your team’s setup records. A matching callback URL alone does not establish ownership.</p>
      <p className="text-muted-foreground">If ownership is unclear, leave the webhook unchanged and ask the person who configured it. Do not replace another organization’s secret or add this organization’s marker to its webhook.</p>
      {!details ? <Button variant="outline" size="sm" disabled={pending} onClick={() => {
        setFeedback(null);
        startTransition(async () => {
          try {
            const result = await getIntegrationWebhookDetails(provider);
            if (result.error) setFeedback({ error: result.error });
            else setDetails(result.details);
          } catch { setFeedback({ error: "Webhook details could not be loaded. Try again in a moment." }); }
        });
      }}>{pending ? "Loading details…" : "Show webhook details"}</Button> : <>
        {details.hookId && <p className="break-all text-muted-foreground">Saved webhook ID: <code>{details.hookId}</code></p>}
        <div className="space-y-1.5"><Label htmlFor={`${provider}-webhook-url`}>Callback URL</Label><Input id={`${provider}-webhook-url`} value={details.url} readOnly onFocus={event => event.target.select()} /></div>
        {details.description && <div className="space-y-1.5"><Label htmlFor={`${provider}-webhook-description`}>Webhook description</Label><Input id={`${provider}-webhook-description`} value={details.description} readOnly onFocus={event => event.target.select()} /></div>}
        <div className="space-y-1.5"><Label htmlFor={`${provider}-webhook-secret`}>Current connection secret</Label><Input id={`${provider}-webhook-secret`} type={revealed ? "text" : "password"} autoComplete="off" value={details.secret} readOnly onFocus={event => event.target.select()} /></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? "Hide secret" : "Reveal secret"}</Button>
          <Button variant="outline" size="sm" onClick={async () => {
            try { await navigator.clipboard.writeText(details.secret); setFeedback({ message: "Webhook secret copied." }); }
            catch { setFeedback({ error: "Copy failed. Select and copy the secret manually." }); }
          }}>Copy secret</Button>
        </div>
        <p className="text-muted-foreground">{provider === "bitbucket"
          ? "In the workspace webhook settings, use this URL, description and current connection secret. Enable pull request created, updated and comment-created events, and keep the webhook active."
          : "In each affected project’s webhook settings, use this URL and re-enter the current connection secret token when changing the URL. Enable merge request and comment events, keep SSL verification enabled, and enable the webhook."}</p>
        <p className="text-muted-foreground">The URL or description identifies this connection generation. After disconnecting and reconnecting, reload these details and save both the current secret and marker together. Save your changes, then run the setup check above. A successful configuration check still needs a pull request event to confirm delivery.</p>
      </>}
      {feedback?.error && <p role="alert" className="text-destructive">{feedback.error}</p>}
      {feedback?.message && <p role="status" className="text-muted-foreground">{feedback.message}</p>}
    </div>
  </details>;
}
