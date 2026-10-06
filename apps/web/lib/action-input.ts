import "server-only";

import { isPostgresSafeText } from "@/lib/bounded-json";

/** Server Action arguments have no runtime TypeScript guarantees. */
export function isActionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && isPostgresSafeText(value);
}
