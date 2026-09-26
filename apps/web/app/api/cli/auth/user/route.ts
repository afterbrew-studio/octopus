import "server-only";
import { authenticateCliUser, revokeCliUserSession } from "@/lib/cli-user-auth";

export async function GET(request: Request) {
  const identity = await authenticateCliUser(request);
  if (!identity) return Response.json({ error: "Invalid or expired CLI session." }, { status: 401 });
  return Response.json({ user: { name: identity.user.name, email: identity.user.email } }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  if (!await revokeCliUserSession(request)) return Response.json({ error: "Invalid CLI session." }, { status: 401 });
  return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
