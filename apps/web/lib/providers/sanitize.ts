/**
 * Replace unpaired UTF-16 surrogates with the replacement char (U+FFFD).
 *
 * JS strings are UTF-16 and can hold lone surrogates — e.g. when review content
 * (a diff or file body) is truncated mid-emoji, splitting a surrogate pair.
 * JSON serialization escapes lone surrogates, but provider decoders can reject
 * those escapes and fail the whole request. Replace only the unpaired halves;
 * valid surrogate pairs (real emoji, astral-plane chars) are left intact.
 */
const LONE_SURROGATE =
  // high surrogate not followed by a low surrogate, OR
  // low surrogate not preceded by a high surrogate
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, "�");
}
