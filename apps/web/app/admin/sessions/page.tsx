import { notFound } from "next/navigation";
import { getSuperAdmin } from "@/lib/superadmin";
import { SessionsClient } from "./sessions-client";

// Per-request: the super-admin guard reads the session, and the env allowlist is
// empty at build time (a static prerender would bake in a 404).
export const dynamic = "force-dynamic";

/**
 * /admin/sessions — vendor (Octopus staff) session-revocation console.
 * Super-admin only (env allowlist); 404 for everyone else so the route isn't
 * disclosed. Hidden on self-host.
 */
export default async function AdminSessionsPage() {
  if (process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED === "true") notFound();

  const sa = await getSuperAdmin();
  if (!sa) notFound();

  return <SessionsClient />;
}
