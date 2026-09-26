import "server-only";
import { prisma } from "@octopus/db";

export async function POST(request: Request) {
  const body = await request.text();
  let scope = "organization";
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_scope");
      if (Object.keys(parsed).length) {
        if (Object.keys(parsed).length !== 1 || parsed.scope !== "user") throw new Error("invalid_scope");
        scope = "user";
      }
    } catch { return Response.json({ error: "Invalid device scope." }, { status: 400 }); }
  }
  // Simple rate limit: max 10 device codes created in the last minute
  const recentCount = await prisma.cliAuthSession.count({
    where: { createdAt: { gte: new Date(Date.now() - 60_000) } },
  });
  if (recentCount >= 10) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  // Generate a random device code
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const deviceCode = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // User approval allows 15 minutes; legacy clients keep their 5-minute window.
  const expiresAt = new Date(Date.now() + (scope === "user" ? 15 : 5) * 60 * 1000);

  await prisma.cliAuthSession.create({
    data: { deviceCode, expiresAt, scope },
  });

  return Response.json({
    deviceCode,
    scope,
    expiresAt: expiresAt.toISOString(),
  });
}
