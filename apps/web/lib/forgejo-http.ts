import "server-only";
import { isSelfHosted } from "@/lib/self-hosted";
import {
  forgejoRequest as request,
  normalizeForgejoHost as normalize,
} from "@octopus/forgejo-connector/http";
export { ForgejoHttpError, ForgejoResponseTooLargeError, isPublicForgejoAddress } from "@octopus/forgejo-connector/http";

function permitsPrivateNetwork(host: string): boolean {
  if (!isSelfHosted()) return false;
  const origin = normalize(host, { allowPrivate: true });
  return (process.env.FORGEJO_ALLOWED_PRIVATE_ORIGINS ?? "").split(",").some(value => {
    try { return normalize(value, { allowPrivate: true }) === origin; } catch { return false; }
  });
}

export function normalizeForgejoHost(value: string): string {
  return normalize(value, { allowPrivate: permitsPrivateNetwork(value) });
}

export function forgejoRequest(host: string, token: string, path: string,
  options: Omit<NonNullable<Parameters<typeof request>[3]>, "allowPrivate"> = {}) {
  return request(host, token, path, { ...options, allowPrivate: permitsPrivateNetwork(host) });
}
