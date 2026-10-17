import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma, type Prisma } from "@octopus/db";

const systemSignup = new AsyncLocalStorage<boolean>();

/** Server-only context: never accept a system source from request input. */
export function withSystemSignup<T>(create: () => T): T {
  return systemSignup.run(true, create);
}

/** Keep the same email, status and expiry match used by onboarding. */
export function findPendingInvitation(email: string) {
  return prisma.organizationInvitation.findFirst({
    where: { email, status: "pending", expiresAt: { gt: new Date() } },
    select: { token: true },
  });
}

type CreationContext = {
  path?: string;
  params?: Record<string, unknown>;
  body?: unknown;
};

type SignupMethod = "github" | "google" | "microsoft" | "magic_link" | "password";

function signupMethod(ctx?: CreationContext | null): SignupMethod | undefined {
  if (systemSignup.getStore()) return "password";
  if (ctx?.path === "/magic-link/verify") return "magic_link";
  if (ctx?.path === "/sign-up/email") return "password";
  const provider = ctx?.path?.startsWith("/callback/")
    ? ctx.params?.id
    : ctx?.path === "/sign-in/social" && ctx.body && typeof ctx.body === "object"
      ? (ctx.body as Record<string, unknown>).provider
      : undefined;
  return provider === "github" || provider === "google" || provider === "microsoft"
    ? provider : undefined;
}

/** Optional facts for the user INSERT, never for linking or later updates. */
export async function userCreationProvenance(email: string, ctx?: CreationContext | null) {
  let method: SignupMethod | undefined;
  try { method = signupMethod(ctx); } catch { /* Unknown context must not block creation. */ }
  let arrivalSource: "system" | "invite" | "signup" | undefined;
  try {
    arrivalSource = systemSignup.getStore() ? "system"
      : await findPendingInvitation(email) ? "invite" : "signup";
  } catch { /* Unavailable invitation evidence remains unknown. */ }
  return {
    ...(method ? { signupMethod: method } : {}),
    ...(arrivalSource ? { arrivalSource } : {}),
  };
}

/** Check for any membership, including removed memberships, just before INSERT. */
export async function organizationCreationProvenance(
  tx: Prisma.TransactionClient,
  userId: string,
  creationSource: "auto_default" | "user_created",
) {
  let creatorFirstOrganization: boolean | undefined;
  // A failed optional query must not leave PostgreSQL's transaction aborted.
  let savepoint = false;
  try {
    await tx.$executeRawUnsafe("SAVEPOINT creation_provenance");
    savepoint = true;
    creatorFirstOrganization = await tx.organizationMember.findFirst({ where: { userId }, select: { id: true } }) === null;
  } catch {
    if (savepoint) await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT creation_provenance");
  } finally {
    if (savepoint) await tx.$executeRawUnsafe("RELEASE SAVEPOINT creation_provenance");
  }
  return {
    creationSource,
    ...(creatorFirstOrganization !== undefined ? { creatorFirstOrganization } : {}),
  };
}
