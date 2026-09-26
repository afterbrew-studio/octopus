/** Admission limits for optional rich rendering of untrusted review Markdown. */
export function canRenderReviewMarkdown(body: string): boolean {
  if (body.length > 64_000) return false;
  let punctuation = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (((code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
         (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) &&
        ++punctuation > 2_048) return false;
  }
  return true;
}
