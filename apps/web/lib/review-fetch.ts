/** Bound the serialized provider page before JSON parsing. Large pages fail
 * explicitly; they must never turn into a partial array that looks complete. */
export async function readReviewJson<T = unknown>(response: Response, maxBytes = 16 * 1024 * 1024): Promise<T> {
  if (!response.body) throw new Error("Empty review input response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Review input page exceeds fetch budget");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as T;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
