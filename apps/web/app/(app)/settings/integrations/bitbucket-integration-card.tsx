"use client";

import { useState, useTransition } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IconBrandBitbucket, IconArrowRight } from "@tabler/icons-react";
import { disconnectBitbucket } from "./actions";
import { IntegrationSetupPanel } from "./integration-setup-panel";
import type { IntegrationSetupStatus } from "@/lib/integration-setup";

type BitbucketData = {
  workspaceName: string;
  workspaceSlug: string;
  setupStatus?: IntegrationSetupStatus;
} | null;

export function BitbucketIntegrationCard({ data, canManage }: { data: BitbucketData; canManage: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!data) {
    return (
      <Card id="bitbucket" className="min-w-0 scroll-mt-6">
        <CardHeader>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center">
              <IconBrandBitbucket className="size-6 text-[#0052CC] dark:text-[#79B8FF]" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">Bitbucket</CardTitle>
              <CardDescription>
                Connect your Bitbucket workspace for code reviews.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-3">How it works</p>
            <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside mb-5">
              <li>Enter your workspace slug below</li>
              <li>Authorize Octopus on Bitbucket</li>
              <li>Check repository sync and webhook setup here, then choose a repository</li>
            </ol>

            {!canManage && <p className="text-muted-foreground mb-3 text-sm">An organization owner or admin can connect Bitbucket.</p>}
            <fieldset disabled={!canManage} className="space-y-3">
              <Label htmlFor="bitbucket-workspace">Workspace slug</Label>
              <Input
                id="bitbucket-workspace"
                placeholder="Workspace slug (e.g. my-team)"
                value={workspaceSlug}
                onChange={(e) => setWorkspaceSlug(e.target.value.toLowerCase())}
                onBlur={(e) => setWorkspaceSlug(e.target.value.trim())}
              />
              <p className="text-muted-foreground text-xs">
                Find it in your Bitbucket URL: bitbucket.org/<span className="font-medium text-foreground">{workspaceSlug || "your-workspace"}</span>
              </p>

              <Button
                className="w-full"
                size="lg"
                disabled={!canManage || !workspaceSlug.trim()}
                onClick={() => {
                  if (workspaceSlug) {
                    window.location.href = `/api/bitbucket/oauth?workspace=${encodeURIComponent(workspaceSlug)}`;
                  }
                }}
              >
                <IconBrandBitbucket className="mr-2 size-4" />
                Connect Bitbucket workspace
                <IconArrowRight className="ml-2 size-4" />
              </Button>

              <p className="text-muted-foreground text-center text-xs">
                Octopus accesses repository content for indexing and posts review comments.
              </p>
            </fieldset>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="bitbucket" className="min-w-0 scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center">
              <IconBrandBitbucket className="size-6 text-[#0052CC] dark:text-[#79B8FF]" />
            </div>
            <div>
              <CardTitle className="text-base">Bitbucket</CardTitle>
              <CardDescription className="break-all">
                Connected to <span className="font-medium">{data.workspaceName}</span>
                {" "}
                <span className="text-muted-foreground">({data.workspaceSlug})</span>
              </CardDescription>
            </div>
          </div>
          <Badge variant="secondary" className="text-green-700 bg-green-100">
            Access authorized
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <IntegrationSetupPanel provider="bitbucket" setupStatus={data.setupStatus} canManage={canManage} />
        {canManage && <div className="border-t pt-4">
          <Button
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                try {
                  const result = await disconnectBitbucket();
                  if (result?.error) setError(result.error);
                } catch { setError("Bitbucket could not be disconnected. Try again in a moment."); }
              });
            }}
          >
            Disconnect Bitbucket
          </Button>
        </div>}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}
