/**
 * Replace unpaired UTF-16 surrogates with the replacement char (U+FFFD).
 *
 * JS strings are UTF-16 and can hold lone surrogates — e.g. when review content
 * (a diff or file body) is truncated mid-emoji, splitting a surrogate pair.
 * Serializing such a string into a JSON request body produces invalid UTF-8,
 * and Anthropic rejects the whole request with
 * `400 invalid_request_error: ... no low surrogate in string`, failing the
 * review. This strips only the UNPAIRED halves; valid surrogate pairs (real
 * emoji, astral-plane chars) are left intact.
 */
const LONE_SURROGATE =
  // high surrogate not followed by a low surrogate, OR
  // low surrogate not preceded by a high surrogate
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, "�");
}
