"use client";

import { useState } from "react";
import { IconCoin } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { PurchaseDialog } from "@/app/(app)/settings/billing/purchase-dialog";

// Discoverable top-up entry point for the dashboard header. Opens the same
// purchase dialog used on the billing page (which shows the volume bonus), so
// buying credits never requires digging into Settings → Billing.
export function BuyCreditsButton({
  card,
}: {
  card?: { brand: string; last4: string } | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <IconCoin className="mr-1.5 size-4" />
        Buy Credits
        <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300">
          Up to 70% bonus
        </span>
      </Button>
      <PurchaseDialog open={open} onOpenChange={setOpen} card={card} />
    </>
  );
}
