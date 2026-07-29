import { NextResponse } from "next/server";
import { headers, cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { uploadToR2, deleteFromR2, extractR2Key, isR2Configured } from "@/lib/r2";
import { writeAuditLog } from "@/lib/audit";
import { fixedWindowLimit, tooManyRequests } from "@/lib/rate-limit";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const OUTPUT_SIZE = 512;
// Reject a compressed "pixel bomb" before libvips allocates the raster: a few MB
// can decode to hundreds of MP. 100 MP covers any real avatar source; sharp's
// ~268 MP default would otherwise let a 5 MB input drive a ~1–2 GB allocation.
const MAX_INPUT_PIXELS = 100_000_000;
// Avatar changes are rare; this is generous for real use and caps the CPU/R2/
// audit cost of an unthrottled loop. The endpoint is also exempt from Cloudflare
// edge rate limiting, so the app is the only place this can be enforced.
const UPLOAD_LIMIT = 10;
const UPLOAD_WINDOW_S = 10 * 60; // 10 minutes

async function getOwnerContext() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Unauthorized", status: 401 as const };

  const cookieStore = await cookies();
  const orgId = cookieStore.get("current_org_id")?.value;
  if (!orgId) return { error: "No organization selected.", status: 400 as const };

  const member = await prisma.organizationMember.findFirst({
    where: { organizationId: orgId, userId: session.user.id, deletedAt: null },
    select: { role: true },
  });
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return { error: "Only organization owners and admins can change the avatar.", status: 403 as const };
  }
  return { userId: session.user.id, userEmail: session.user.email, orgId };
}

export async function POST(req: Request) {
  if (!isR2Configured()) {
    return NextResponse.json({ error: "File storage is not configured." }, { status: 500 });
  }

  const ctx = await getOwnerContext();
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  // Throttle before the expensive work (formData read + sharp decode/resize +
  // R2 write + audit row). Keyed per user; fails open on a Redis outage.
  const rl = await fixedWindowLimit(`avatar-upload:${ctx.userId}`, UPLOAD_LIMIT, UPLOAD_WINDOW_S);
  if (!rl.ok) return tooManyRequests("Too many avatar uploads. Try again later.", rl.retryAfterSeconds);

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WEBP, or GIF images are allowed." },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Image must be smaller than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` },
      { status: 400 },
    );
  }

  const inputBuffer = Buffer.from(await file.arrayBuffer());

  let outputBuffer: Buffer;
  try {
    outputBuffer = await sharp(inputBuffer, { failOn: "truncated", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "center" })
      .webp({ quality: 88 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "Could not process image." }, { status: 400 });
  }

  const key = `org-avatars/${ctx.orgId}/${randomBytes(8).toString("hex")}.webp`;

  const existing = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { avatarUrl: true },
  });

  const avatarUrl = await uploadToR2(key, outputBuffer, "image/webp");

  await prisma.organization.update({
    where: { id: ctx.orgId },
    data: { avatarUrl },
  });

  if (existing?.avatarUrl) {
    const oldKey = extractR2Key(existing.avatarUrl);
    if (oldKey) {
      deleteFromR2(oldKey).catch((err) =>
        console.error("[org-avatar] Failed to delete old avatar:", err),
      );
    }
  }

  await writeAuditLog({
    action: "organization.avatar.update",
    category: "admin",
    actorId: ctx.userId,
    actorEmail: ctx.userEmail,
    organizationId: ctx.orgId,
    targetType: "organization",
    targetId: ctx.orgId,
    metadata: { previousAvatar: existing?.avatarUrl ?? null, newAvatar: avatarUrl },
  });

  revalidatePath("/", "layout");
  return NextResponse.json({ avatarUrl });
}

export async function DELETE() {
  const ctx = await getOwnerContext();
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const existing = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { avatarUrl: true },
  });

  if (!existing?.avatarUrl) {
    return NextResponse.json({ avatarUrl: null });
  }

  await prisma.organization.update({
    where: { id: ctx.orgId },
    data: { avatarUrl: null },
  });

  const oldKey = extractR2Key(existing.avatarUrl);
  if (oldKey) {
    deleteFromR2(oldKey).catch((err) =>
      console.error("[org-avatar] Failed to delete avatar:", err),
    );
  }

  await writeAuditLog({
    action: "organization.avatar.remove",
    category: "admin",
    actorId: ctx.userId,
    actorEmail: ctx.userEmail,
    organizationId: ctx.orgId,
    targetType: "organization",
    targetId: ctx.orgId,
    metadata: { previousAvatar: existing.avatarUrl },
  });

  revalidatePath("/", "layout");
  return NextResponse.json({ avatarUrl: null });
}
