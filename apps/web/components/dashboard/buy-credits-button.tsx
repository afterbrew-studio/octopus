"use client";

import { useState } from "react";
import { IconCoin } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { PurchaseDialog } from "@/app/(app)/settings/billing/purchase-dialog";

// Discoverable top-up entry point for the dashboard header. Opens the same
// purchase dialog used on the billing page (which shows the volume bonus), so
// buying credits never requires digging into Settings → Billing.
export function BuyCreditsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <IconCoin className="mr-1.5 size-4" />
        Buy Credits
        <span className="ml-2 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          up to 70% bonus
        </span>
      </Button>
      <PurchaseDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
