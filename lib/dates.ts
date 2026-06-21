/**
 * Returns the current calendar date (YYYY-MM-DD) in the given IANA timezone,
 * adjusted for a configurable day-turnover hour.
 *
 * If `turnoverHour` > 0 and the current local hour is before `turnoverHour`,
 * the date returned is yesterday's — so studying at 3 AM with turnover=4
 * counts as part of the previous calendar day.
 */
export function getToday(tz = 'UTC', turnoverHour = 0): string {
  const now = new Date()
  if (turnoverHour > 0) {
    // Get the current hour in the user's timezone (en-US h23 gives 0-23)
    const localHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now),
      10
    ) % 24  // guard against locale returning "24" for midnight
    if (localHour < turnoverHour) {
      // It's before the turnover — treat as the previous calendar day
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      return yesterday.toLocaleDateString('en-CA', { timeZone: tz })
    }
  }
  if (tz === 'UTC') return now.toISOString().slice(0, 10)
  return now.toLocaleDateString('en-CA', { timeZone: tz })
}
