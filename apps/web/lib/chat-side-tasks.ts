import "server-only";
import { getUtilityModel } from "./ai-client";
import { createAiMessage } from "./ai-router";
import { logAiUsage } from "./ai-usage";

/** Short model calls around a chat turn, all on the utility model. */

/** Generates a conversation title from a caller-built prompt; the caller handles failure. */
export async function generateChatTitle(prompt: string, orgId: string, fallback: string): Promise<string> {
  const model = await getUtilityModel(orgId);
  const res = await createAiMessage(
    { model, maxTokens: 50, thinking: "disabled", messages: [{ role: "user", content: prompt }] },
    orgId,
  );
  await logAiUsage({
    provider: res.provider,
    usedOwnKey: res.usedOwnKey,
    model,
    operation: "chat-title",
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    cacheReadTokens: res.usage.cacheReadTokens,
    cacheWriteTokens: res.usage.cacheWriteTokens,
    organizationId: orgId,
  });
  return res.text.trim() || fallback;
}

/** Returns the text unchanged when it needs no translation or translation fails. */
export async function translateToEnglish(text: string, orgId: string): Promise<string> {
  // Skip translation for ASCII-only and Latin-extended text (accented chars like é, ñ, ü).
  // Only translate when non-Latin scripts are detected (Cyrillic, CJK, Arabic, Turkish İ/ı, etc.)
  const hasNonLatinScript = /[^\u0000-ɏḀ-ỿ]/.test(text);
  if (!hasNonLatinScript) return text;

  try {
    const model = await getUtilityModel(orgId);
    const res = await createAiMessage(
      {
        model,
        maxTokens: 1024,
        thinking: "disabled",
        system:
          "If the following text is already in English, return it as-is. Otherwise translate it to English. Return ONLY the translated text, nothing else.",
        messages: [{ role: "user", content: text }],
      },
      orgId,
    );
    await logAiUsage({
      provider: res.provider,
      usedOwnKey: res.usedOwnKey,
      model,
      operation: "chat-translate",
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens,
      cacheWriteTokens: res.usage.cacheWriteTokens,
      organizationId: orgId,
    });
    return res.text.trim() || text;
  } catch {
    return text;
  }
}
