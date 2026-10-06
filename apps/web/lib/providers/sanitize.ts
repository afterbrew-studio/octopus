/**
 * Replace unpaired UTF-16 surrogates with the replacement char (U+FFFD).
 *
 * JS strings are UTF-16 and can hold lone surrogates — e.g. when review content
 * (a diff or file body) is truncated mid-emoji, splitting a surrogate pair.
 * JSON serialization escapes lone surrogates, but provider decoders can reject
 * those escapes and fail the whole request. Replace only the unpaired halves;
 * valid surrogate pairs (real emoji, astral-plane chars) are left intact.
 *
 * Native, so a multi-megabyte prompt costs microseconds rather than the regex
 * lookbehind scan this replaced (about 100ms per call at the request-size cap).
 */
export function stripLoneSurrogates(s: string): string {
  return s.toWellFormed();
}
