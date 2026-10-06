import "server-only";

import { isPostgresSafeText } from "@/lib/bounded-json";

/** These settings forms accept text fields, never uploaded files. */
export function isTextFormData(value: unknown, requiredFields: readonly string[] = []): value is FormData {
  return value instanceof FormData &&
    requiredFields.every((field) => value.has(field)) &&
    Array.from(value.values()).every((field) =>
      typeof field === "string" && isPostgresSafeText(field));
}
