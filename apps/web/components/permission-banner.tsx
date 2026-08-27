"use client";

import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";

type Org = { id: string; name: string };

export function PermissionBanner({
  orgs,
  appDeclaresPermission = true,
  appSettingsUrl,
}: {
  orgs: Org[];
  /**
   * Whether the App itself asks for the permission. An installation cannot hold one the App
   * does not declare, so offering "Grant" in that case sends the owner somewhere with nothing
   * to accept - the button appears broken because the fix is not theirs to make.
   */
  appDeclaresPermission?: boolean;
  appSettingsUrl?: string;
}) {
  if (orgs.length === 0) return null;

  const orgNames = orgs.map((o) => o.name).join(", ");
  // Explicit rather than relying on the `current_org_id` cookie, which the route falls back
  // to: the banner already knows which org is short, and the cookie may name a different one.
  const grantHref = `/api/github/install?orgId=${encodeURIComponent(orgs[0].id)}&returnTo=/dashboard`;

  return (
    <div className="sticky top-0 z-50">
      <div className="flex items-center justify-between gap-3 bg-red-950 px-4 py-1.5">
        <div className="flex items-center gap-2 overflow-hidden">
          <IconAlertTriangle className="size-3.5 shrink-0 text-red-400" />
          <p className="truncate text-xs text-red-200">
            <span className="font-medium">Permissions required:</span> {orgNames}
            <span className="text-red-200/50">
              {appDeclaresPermission
                ? " — disappears after next successful review"
                : " — the App does not request check-run write access, so this cannot be granted here"}
            </span>
          </p>
        </div>
        {appDeclaresPermission ? (
          <a
            href={grantHref}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/30"
          >
            Grant
            <IconExternalLink className="size-2.5" />
          </a>
        ) : (
          appSettingsUrl && (
            <a
              href={appSettingsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/30"
            >
              Update the App
              <IconExternalLink className="size-2.5" />
            </a>
          )
        )}
      </div>
    </div>
  );
}
