/** Escape user-controlled strings before interpolating into HTML templates. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Return the URL if it uses http(s), otherwise return "#". */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : "#";
  } catch {
    return "#";
  }
}

/** Serialize JSON for an inline application/ld+json script without allowing </script>. */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Render the small inline-markup subset supported by notification emails.
 * Every text/attribute value is escaped before approved tags are introduced.
 */
export function formatInlineEmailHtml(text: string): string {
  const markup = /\*\*(.+?)\*\*|\[([^\]]+)]\(([^)]+)\)|`([^`]+)`/g;
  let output = "";
  let cursor = 0;

  for (const match of text.matchAll(markup)) {
    const index = match.index ?? 0;
    output += escapeHtml(text.slice(cursor, index));

    if (match[1] !== undefined) {
      output += `<strong>${escapeHtml(match[1])}</strong>`;
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const href = escapeHtml(sanitizeUrl(match[3].trim()));
      output += `<a href="${href}" style="color: #0366d6; text-decoration: underline;">${escapeHtml(match[2])}</a>`;
    } else if (match[4] !== undefined) {
      output += `<code style="background: #f0f0f0; padding: 2px 4px; border-radius: 3px; font-size: 13px;">${escapeHtml(match[4])}</code>`;
    }
    cursor = index + match[0].length;
  }

  return output + escapeHtml(text.slice(cursor));
}
