/**
 * Why a provider call failed for a reason that says nothing about the request,
 * or null when the request itself is at fault.
 *
 * Unavailable: 429 (rate limit or quota), 402 (billing exhausted), 408 and 5xx,
 * and a connection or timeout failure with no HTTP status. Not unavailable: any
 * other 4xx. 400 and 422 mean the request is bad, so another model gets the same
 * answer. 401 and 403 mean this deployment's credentials are wrong, which a
 * fallback would hide behind a working model for as long as nobody looks.
 *
 * The SDKs put the HTTP status on the error and bury the socket error under
 * `cause`, so the whole chain is read. Status wins over a socket code, which
 * wins over the SDK's connection error class.
 */
const SOCKET_CODES = new Set([
  "ECONNRESET", "EPIPE", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

type Link = { status?: unknown; code?: unknown; cause?: unknown; constructor?: { name?: string } };

function errorChain(error: unknown): Link[] {
  const chain: Link[] = [];
  for (let current = error; current && typeof current === "object" && chain.length < 6; current = (current as Link).cause) {
    chain.push(current as Link);
  }
  return chain;
}

export function providerUnavailableReason(error: unknown): string | null {
  const chain = errorChain(error);
  const status = chain.find((link) => typeof link.status === "number")?.status as number | undefined;
  if (status !== undefined) {
    return status === 429 || status === 402 || status === 408 || (status >= 500 && status <= 599) ? String(status) : null;
  }
  for (const link of chain) {
    if (typeof link.code !== "string") continue;
    if (TIMEOUT_CODES.has(link.code)) return "timeout";
    if (SOCKET_CODES.has(link.code)) return "connection";
  }
  for (const link of chain) {
    const name = link.constructor?.name;
    if (name === "APIConnectionTimeoutError") return "timeout";
    if (name === "APIConnectionError") return "connection";
  }
  return null;
}
