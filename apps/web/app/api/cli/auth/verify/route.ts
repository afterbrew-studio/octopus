import { authenticateCliUser } from "@/lib/cli-user-auth";
import { authenticateApiToken } from "@/lib/api-auth";

export async function POST(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer oct_u_")) {
    const identity = await authenticateCliUser(request);
    if (!identity) return Response.json({ error: "Invalid or expired CLI session" }, { status: 401 });
    return Response.json({ scope: "user", organization: null, user: { id: identity.user.id, name: identity.user.name, email: identity.user.email } }, { headers: { "Cache-Control": "no-store" } });
  }
  const result = await authenticateApiToken(request);
  if (result instanceof Response) return result; // account-standing hold (403), pass through
  if (!result) {
    return Response.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  return Response.json({
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
    },
    organization: {
      id: result.org.id,
      name: result.org.name,
      slug: result.org.slug,
    },
  });
}
