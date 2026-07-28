"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { setPlatformReviewEffort } from "./actions";

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

export function SettingsClient({
  currentEffort,
  builtInDefault,
}: {
  currentEffort: string | null;
  builtInDefault: string;
}) {
  const [selected, setSelected] = useState(currentEffort ?? "");
  const [saving, startTransition] = useTransition();
  const [result, setResult] = useState<{ error?: string; success?: boolean }>({});

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold">Platform Settings</h1>
        <p className="text-sm text-muted-foreground">
          Defaults applied across all organizations. Orgs can override these on their
          own settings pages.
        </p>
      </div>

      <form
        action={(formData) => {
          startTransition(async () => {
            setResult({});
            setResult(await setPlatformReviewEffort({}, formData));
          });
        }}
        className="space-y-4 rounded-lg border p-5"
      >
        <div className="space-y-2">
          <Label htmlFor="defaultReviewEffort">Default Reasoning Effort</Label>
          <select
            id="defaultReviewEffort"
            name="defaultReviewEffort"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors"
          >
            <option value="">{`(Built-in default — ${builtInDefault})`}</option>
            {EFFORT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            How hard extended-thinking models (Fable, Opus 5) reason before answering.
            Higher effort is more thorough but slower. Ignored by models without
            extended thinking. An org override takes precedence over this.
          </p>
        </div>

        {result.error && <p className="text-sm text-destructive">{result.error}</p>}
        {result.success && <p className="text-sm text-green-600">Saved.</p>}

        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>
    </div>
  );
}
