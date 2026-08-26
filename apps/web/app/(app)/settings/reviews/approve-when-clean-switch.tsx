"use client";

import { useActionState, useRef } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { updateApproveWhenClean } from "../../actions";

/**
 * The one review setting that can let code merge with no human in the loop, so
 * it says exactly that rather than describing itself as a formatting
 * preference. What it grants is only meaningful to something downstream that
 * waits on an approval, which is why the copy names that consequence instead of
 * the mechanism.
 */
export function ApproveWhenCleanSwitch({
  isOwner,
  enabled,
}: {
  isOwner: boolean;
  enabled: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(updateApproveWhenClean, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approve Clean Reviews</CardTitle>
        <CardDescription>
          When enabled, a review that found nothing is submitted as an approval
          rather than a comment. Anything that merges on approval — branch
          protection, an automation — will then be able to proceed without a
          person. A review that found anything at all still comments or requests
          changes, and a partial or truncated review never approves.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction}>
          <input
            type="hidden"
            name="approveWhenClean"
            value={enabled ? "false" : "true"}
          />
          <div className="flex items-center justify-between">
            <Label htmlFor="approve-when-clean" className="flex flex-col gap-1">
              <span className="font-medium">
                {enabled ? "Clean reviews are approved" : "Clean reviews are commented"}
              </span>
              <span className="text-xs text-muted-foreground font-normal">
                {enabled
                  ? "A clean review can unblock an automated merge."
                  : "Nothing this reviewer does can unblock a merge."}
              </span>
            </Label>
            <Switch
              id="approve-when-clean"
              checked={enabled}
              disabled={!isOwner || pending}
              onCheckedChange={() => formRef.current?.requestSubmit()}
            />
          </div>

          {state.error && (
            <p className="text-sm text-destructive mt-3">{state.error}</p>
          )}

          {!isOwner && (
            <p className="text-muted-foreground text-xs mt-3">
              Only owners and admins can grant this.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
