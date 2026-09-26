// Shared validation is deliberately independent of the web app and runtime.
// A connector grants this small API surface, never a general network proxy.
export const FORGEJO_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const FORGEJO_MAX_REQUEST_BYTES = 1024 * 1024;

export type ForgejoOperation = {
  path: string;
  method: "GET" | "POST" | "PATCH";
  body?: unknown;
  maxBytes: number;
};
export type ForgejoCommand = ForgejoOperation & {
  id: string;
  leaseToken: string;
  expiresAt: string;
};
export type ForgejoResult = { id: string; leaseToken: string } & (
  { result: { body: string; headers: { "x-hasmore"?: string } } }
  | { error: "http"; status: number }
  | { error: "too_large" | "failed" }
);

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const lease = /^[a-f0-9]{64}$/;
const invalid = (): never => { throw new Error("Invalid Forgejo connector operation"); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function string(value: unknown, max = FORGEJO_MAX_REQUEST_BYTES): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= max;
}
const encodedControl = /%(?:25|2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i;
function segment(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 255 && decoded !== "." && decoded !== ".."
      && !/[\\/\x00-\x1f\x7f]/.test(decoded) && !encodedControl.test(decoded);
  } catch { return false; }
}
function filePath(value: unknown): value is string {
  return string(value, 4096) && value.length > 0 && value.split("/").every(part =>
    part.length > 0 && part !== "." && part !== ".." && !/[\\\x00-\x1f\x7f]/.test(part));
}
function ref(value: string): boolean {
  return filePath(value) && !encodedControl.test(value);
}
function positive(value: string, max = Number.MAX_SAFE_INTEGER): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max;
}
function query(url: URL, rules: Record<string, (value: string) => boolean>): void {
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !Object.hasOwn(rules, key) || !rules[key](value)) invalid();
    seen.add(key);
  }
}
function commentBody(value: unknown): void {
  const body = object(value);
  keys(body, ["body"]);
  if (!string(body.body)) invalid();
}

export function validateForgejoOperation(value: ForgejoOperation): void {
  const op = object(value);
  if (!string(op.path, 8192) || !op.path.startsWith("/api/v1/") || /[\\\x00-\x20\x7f#]/.test(op.path)
    || !["GET", "POST", "PATCH"].includes(op.method as string)
    || !Number.isSafeInteger(op.maxBytes) || (op.maxBytes as number) < 1
    || (op.maxBytes as number) > FORGEJO_MAX_RESPONSE_BYTES) invalid();
  let url: URL;
  try { url = new URL(op.path as string, "https://forgejo.invalid"); } catch { return invalid(); }
  // URL parsing normalizes dot segments; compare the original path first.
  if (url.origin !== "https://forgejo.invalid" || url.pathname !== (op.path as string).split("?")[0]) invalid();
  const parts = url.pathname.slice("/api/v1/".length).split("/");
  const method = op.method;
  if (method === "GET" && op.body !== undefined) invalid();
  if (op.body !== undefined) {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(op.body); } catch { return invalid(); }
    if (!serialized || Buffer.byteLength(serialized) > FORGEJO_MAX_REQUEST_BYTES) invalid();
  }

  if (method === "GET" && parts[0] === "user") {
    if (parts.length === 1) { query(url, {}); return; }
    if (parts.length === 2 && parts[1] === "repos") {
      query(url, { limit: value => positive(value, 50), page: value => positive(value, 200), order_by: value => value === "id" });
      return;
    }
  }
  if (parts[0] !== "repos" || !segment(parts[1] ?? "") || !segment(parts[2] ?? "")) invalid();
  const route = parts.slice(3);
  if (method === "GET") {
    if (route[0] === "pulls" && route.length === 2 && positive(route[1].replace(/\.diff$/, ""))) {
      query(url, {}); return;
    }
    if (route[0] === "pulls" && positive(route[1] ?? "") && route.length === 3 && route[2] === "files") {
      query(url, { limit: value => positive(value, 50), page: value => positive(value, 60) }); return;
    }
    if (route[0] === "branches" && route.length === 2) {
      let branch: string;
      try { branch = decodeURIComponent(route[1]); } catch { return invalid(); }
      if (!ref(branch)) invalid();
      query(url, {}); return;
    }
    if (route[0] === "git" && route[1] === "trees" && route.length === 3 && sha.test(route[2])) {
      query(url, { recursive: value => value === "true", per_page: value => positive(value, 1000), page: value => positive(value, 100) }); return;
    }
    if (route[0] === "contents" && route.length > 1 && route.slice(1).every(segment)) {
      query(url, { ref }); return;
    }
  } else {
    query(url, {});
    if ((method === "POST" && route[0] === "issues" && positive(route[1] ?? "") && route[2] === "comments" && route.length === 3)
      || (method === "PATCH" && route[0] === "issues" && route[1] === "comments" && positive(route[2] ?? "") && route.length === 3)) {
      commentBody(op.body); return;
    }
    const body = object(op.body);
    if (method === "POST" && route[0] === "pulls" && positive(route[1] ?? "") && route[2] === "reviews" && route.length === 3) {
      keys(body, ["body", "event", "commit_id", "comments"]);
      if (!string(body.body) || body.event !== "COMMENT" || typeof body.commit_id !== "string" || !sha.test(body.commit_id)
        || !Array.isArray(body.comments) || body.comments.length > 1000) invalid();
      for (const entry of body.comments as unknown[]) {
        const comment = object(entry);
        keys(comment, ["path", "body", "new_position", "old_position"]);
        if (!filePath(comment.path) || !string(comment.body) || !Number.isSafeInteger(comment.new_position)
          || (comment.new_position as number) <= 0 || comment.old_position !== 0) invalid();
      }
      return;
    }
    if (method === "POST" && route[0] === "statuses" && route.length === 2 && sha.test(route[1])) {
      keys(body, ["state", "context", "description", "target_url"]);
      if (!["pending", "success", "failure", "error"].includes(body.state as string)
        || !string(body.context, 255) || !body.context || !string(body.description, 1020)) invalid();
      if (body.target_url !== undefined) {
        if (!string(body.target_url, 2048)) invalid();
        let target: URL;
        try { target = new URL(body.target_url as string); } catch { return invalid(); }
        if (target.protocol !== "https:" || target.username || target.password) invalid();
      }
      return;
    }
  }
  invalid();
}

function binding(value: Record<string, unknown>): void {
  if (typeof value.id !== "string" || !identifier.test(value.id)
    || typeof value.leaseToken !== "string" || !lease.test(value.leaseToken)) invalid();
}

export function validateForgejoCommand(value: unknown): ForgejoCommand {
  const command = object(value);
  keys(command, ["id", "leaseToken", "path", "method", "body", "maxBytes", "expiresAt"]);
  binding(command);
  if (typeof command.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(command.expiresAt)
    || !Number.isFinite(Date.parse(command.expiresAt))) invalid();
  validateForgejoOperation(command as ForgejoCommand);
  return command as ForgejoCommand;
}

export function validateForgejoResult(value: unknown): ForgejoResult {
  const result = object(value);
  binding(result);
  if (result.result !== undefined) {
    keys(result, ["id", "leaseToken", "result"]);
    const response = object(result.result);
    keys(response, ["body", "headers"]);
    const headers = object(response.headers);
    keys(headers, ["x-hasmore"]);
    if (!string(response.body, FORGEJO_MAX_RESPONSE_BYTES)
      || (headers["x-hasmore"] !== undefined && headers["x-hasmore"] !== "true" && headers["x-hasmore"] !== "false")) invalid();
  } else if (result.error === "http") {
    keys(result, ["id", "leaseToken", "error", "status"]);
    if (!Number.isSafeInteger(result.status) || (result.status as number) < 100 || (result.status as number) > 599
      || ((result.status as number) >= 200 && (result.status as number) < 300)) invalid();
  } else {
    keys(result, ["id", "leaseToken", "error"]);
    if (result.error !== "failed" && result.error !== "too_large") invalid();
  }
  return result as ForgejoResult;
}
