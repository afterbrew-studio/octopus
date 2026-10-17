import "server-only";
import { pubby } from "@/lib/pubby";

export async function notifyRepositoryIndex(channel: string, repoId: string): Promise<void> {
  try {
    await pubby.trigger(channel, "index-status", { repoId });
  } catch (error) {
    console.warn("[repository-index] notification failed:", error);
  }
}
