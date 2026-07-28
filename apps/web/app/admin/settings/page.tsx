import { notFound } from "next/navigation";
import { prisma } from "@octopus/db";
import { getSuperAdmin } from "@/lib/superadmin";
import { DEFAULT_THINKING_EFFORT } from "@/lib/providers/thinking";
import { SettingsClient } from "./settings-client";

// Per-request only: the super-admin guard reads the session, and the env
// allowlist is empty at build time (so a static prerender would bake in a 404).
export const dynamic = "force-dynamic";

/**
 * /admin/settings — vendor (Octopus staff) platform settings. Super-admin only
 * (env allowlist); 404 for everyone else so the route isn't disclosed. Hidden
 * on self-host.
 */
export default async function AdminSettingsPage() {
  if (process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED === "true") notFound();

  const sa = await getSuperAdmin();
  if (!sa) notFound();

  const sysConfig = await prisma.systemConfig.findUnique({
    where: { id: "singleton" },
    select: { defaultReviewEffort: true },
  });

  return (
    <SettingsClient
      currentEffort={sysConfig?.defaultReviewEffort ?? null}
      builtInDefault={DEFAULT_THINKING_EFFORT}
    />
  );
}
