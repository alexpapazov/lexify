/**
 * Returns the current calendar date (YYYY-MM-DD) in the given IANA timezone.
 * Defaults to UTC so existing callers that pass nothing are unaffected.
 */
export function getToday(tz = 'UTC'): string {
  if (tz === 'UTC') return new Date().toISOString().slice(0, 10)
  return new Date().toLocaleDateString('en-CA', { timeZone: tz })
}
