import "server-only";
import { prisma } from "@octopus/db";
import { decryptStringMaybeLegacy } from "@/lib/crypto";
import type { Provider, AiCreateParams, AiResponse } from "./index";
import { callOpenAiGateway, parseExtraBody } from "./openai-gateway";
import { validateProviderUrl } from "./url-validation";

/**
 * OpenCode — an OpenAI-compatible gateway, same shape as ACPX with its own
 * config. Configurable per-org (Organization.opencodeBaseUrl + opencodeApiKey),
 * which overrides the deployment-wide env default:
 *   OPENCODE_BASE_URL — gateway origin
 *   OPENCODE_API_KEY  — bearer token for the gateway
 * Model ids are namespaced "opencode:<model>".
 *
 * The per-org key is stored encrypted at rest like the other BYOK keys, so it
 * is decrypted here before use. SSRF validation is applied only to the per-org
 * (org-admin supplied) base URL; the env-configured OPENCODE_BASE_URL is
 * operator-controlled and may legitimately point at an internal host, so it is
 * only normalized to an origin (private ranges allowed).
 */
async function resolveConfig(orgId?: string | null): Promise<{ apiBase: string; apiKey: string } | null> {
  // Per-org config overrides the deployment env default.
  if (orgId) {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { opencodeBaseUrl: true, opencodeApiKey: true },
    });
    if (org?.opencodeBaseUrl && org?.opencodeApiKey) {
      // Org-supplied: origin only, then the conventional `/v1`. User input
      // stays on the predictable shape.
      return {
        apiBase: `${validateProviderUrl(org.opencodeBaseUrl)}/v1`,
        apiKey: decryptStringMaybeLegacy(org.opencodeApiKey),
      };
    }
  }
  const envBase = process.env.OPENCODE_BASE_URL;
  const envKey = process.env.OPENCODE_API_KEY;
  if (envBase && envKey) {
    // Operator-supplied: the path is kept, and `/v1` is appended only when none
    // was given. An API served at `/api/paas/v4` is configured as such rather
    // than being unreachable.
    const base = validateProviderUrl(envBase, { hosted: false, keepPath: true });
    const apiBase = new URL(base).pathname === "/" ? `${base}/v1` : base;
    return { apiBase, apiKey: envKey };
  }
  return null;
}

export const opencodeProvider: Provider = {
  name: "opencode",
  supportsJsonSchema: true,
  async create(
    params: AiCreateParams,
    _apiKey?: string | null,
    orgId?: string | null,
  ): Promise<AiResponse> {
    const config = await resolveConfig(orgId);
    if (!config) {
      throw new Error(
        "OpenCode is not configured — set OPENCODE_BASE_URL and OPENCODE_API_KEY, or " +
          "configure opencodeBaseUrl and opencodeApiKey on the organization.",
      );
    }
    return callOpenAiGateway(params, {
      name: "opencode",
      modelPrefix: "opencode:",
      apiBase: config.apiBase,
      apiKey: config.apiKey,
      // Operator-supplied vendor extensions, e.g. disabling a model's thinking.
      extraBody: parseExtraBody(process.env.OPENCODE_EXTRA_BODY, "OPENCODE_EXTRA_BODY"),
    });
  },
};
