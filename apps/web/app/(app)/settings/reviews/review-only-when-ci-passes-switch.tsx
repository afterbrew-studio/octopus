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
import { updateReviewOnlyWhenCiPasses } from "../../actions";

export function ReviewOnlyWhenCiPassesSwitch({
  isOwner,
  enabled,
}: {
  isOwner: boolean;
  enabled: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(updateReviewOnlyWhenCiPasses, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wait for CI</CardTitle>
        <CardDescription>
          When enabled, a review is held until the commit&apos;s checks have passed.
          Reviewing a red build spends a model call on a diff that is about to
          change, and the findings go stale as soon as the author pushes the fix.
          Only a known failure holds: a review still runs when checks are pending
          or when nothing has reported, because a reviewer that waits for evidence
          it may never receive stops reviewing altogether.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form ref={formRef} action={formAction}>
          <input
            type="hidden"
            name="reviewOnlyWhenCiPasses"
            value={enabled ? "A failing build defers the review." : "A failing build is reviewed anyway."}
          />
          <div className="flex items-center justify-between">
            <Label htmlFor="review-only-when-ci-passes" className="flex flex-col gap-1">
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
              id="review-only-when-ci-passes"
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
