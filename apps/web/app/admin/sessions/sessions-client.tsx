"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { revokeUserSessionsByEmail, revokeAllSessions } from "./actions";

export function SessionsClient() {
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, startTransition] = useTransition();
  const [userResult, setUserResult] = useState<{ error?: string; success?: boolean; count?: number; email?: string }>({});
  const [allResult, setAllResult] = useState<{ error?: string; success?: boolean; count?: number }>({});

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 md:p-10">
      <div>
        <h1 className="text-xl font-semibold">Session Revocation</h1>
        <p className="text-sm text-muted-foreground">
          Force users to re-authenticate. Revoking a user&apos;s sessions signs them
          out of Octopus entirely, across every organization and device.
        </p>
      </div>

      {/* Revoke a single user's sessions */}
      <form
        action={(formData) => {
          startTransition(async () => {
            setUserResult({});
            setUserResult(await revokeUserSessionsByEmail({}, formData));
          });
        }}
        className="space-y-3 rounded-lg border p-5"
      >
        <div className="space-y-2">
          <Label htmlFor="email">Revoke a user&apos;s sessions</Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Use for a compromised or leaked session. The user stays active and can
            sign back in — this only invalidates their current sessions.
          </p>
        </div>
        {userResult.error && <p className="text-sm text-destructive">{userResult.error}</p>}
        {userResult.success && (
          <p className="text-sm text-green-600">
            Revoked {userResult.count} session{userResult.count === 1 ? "" : "s"} for {userResult.email}.
          </p>
        )}
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>
          {busy ? "Working..." : "Revoke sessions"}
        </Button>
      </form>

      {/* Nuclear: revoke everything */}
      <form
        action={(formData) => {
          startTransition(async () => {
            setAllResult({});
            setAllResult(await revokeAllSessions({}, formData));
          });
        }}
        className="space-y-3 rounded-lg border border-destructive/40 p-5"
      >
        <div className="space-y-2">
          <Label htmlFor="confirm" className="text-destructive">
            Revoke ALL platform sessions
          </Label>
          <p className="text-xs text-muted-foreground">
            Incident response only. Signs out every user on the platform —
            <strong> including you</strong>. Type <code>REVOKE ALL</code> to confirm.
          </p>
          <Input
            id="confirm"
            name="confirm"
            placeholder="REVOKE ALL"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
        </div>
        {allResult.error && <p className="text-sm text-destructive">{allResult.error}</p>}
        {allResult.success && (
          <p className="text-sm text-green-600">Revoked {allResult.count} sessions platform-wide.</p>
        )}
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={busy || confirm !== "REVOKE ALL"}
        >
          {busy ? "Working..." : "Revoke all sessions"}
        </Button>
      </form>
    </div>
  );
}
