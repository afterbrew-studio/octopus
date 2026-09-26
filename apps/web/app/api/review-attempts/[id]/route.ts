import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { auth } from "@/lib/auth";
import { authenticateApiToken } from "@/lib/api-auth";
import { isReviewRecordId, reviewRecordFields, reviewRecordOrganization, reviewRecordScope } from "@/lib/review-record-access";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isReviewRecordId(id)) return Response.json({ error: "Review attempt not found" }, { status: 404 });
  const browserNavigation = request.headers.get("accept")?.split(",").some(value => {
    const [type, ...parameters] = value.trim().split(";");
    return type === "text/html" && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
  });
  if (browserNavigation && !request.headers.has("authorization") && new URL(request.url).searchParams.get("download") !== "1") {
    return new Response(null, { status: 307, headers: {
      Location: `/review-attempts/${id}`, "Cache-Control": "private, no-store", Vary: "Accept",
    } });
  }
  let organization: Prisma.OrganizationWhereInput;
  if (request.headers.has("authorization")) {
    const access = await authenticateApiToken(request);
    if (access instanceof Response) return access;
    if (!access) return Response.json({ error: "Unauthorized" }, { status: 401 });
    organization = { id: access.org.id, bannedAt: null, deletedAt: null };
  } else {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    organization = reviewRecordOrganization(session.user.id);
  }
  const attempt = await prisma.reviewAttempt.findFirst({
    where: reviewRecordScope(id, organization),
    select: reviewRecordFields,
  });
  if (!attempt) return Response.json({ error: "Review attempt not found" }, { status: 404 });
  return Response.json(attempt, { headers: {
    "Cache-Control": "private, no-store",
    Vary: "Accept",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `attachment; filename="review-attempt-${id}.json"`,
  } });
}
