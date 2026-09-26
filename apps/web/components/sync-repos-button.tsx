"use client";

import { IconRefresh } from "@tabler/icons-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncRepos } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";

export function SyncReposButton() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="flex max-w-sm flex-col items-end gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            setMessage(null);
            try {
              const result = await syncRepos();
              if (result.error) setError(result.error);
              else setMessage(`Synced ${result.synced} repositories.`);
              router.refresh();
            } catch {
              setError("Could not sync repositories. Try again or check Settings → Integrations.");
            }
          })
        }
      >
        <IconRefresh className={`mr-1.5 size-3.5 ${isPending ? "animate-spin" : ""}`} />
        {isPending ? "Syncing..." : "Sync Repos"}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
