/**
 * Cached `Intl.DateTimeFormat` instances, keyed by timezone.
 *
 * Constructing a formatter is expensive (tens of microseconds) and these run in hot loops — the
 * analytics Present tab calls `localDateWithTurnover` once per review event, so a 30-day window with
 * ~14k reviews was building ~30k formatters (hundreds of ms of pure formatting) on every load.
 * `toLocaleDateString`/`toLocaleString` construct one internally per call too, hence the explicit
 * `.format()` calls below rather than the terser Date methods.
 */
const dateFmtCache = new Map<string, Intl.DateTimeFormat>()
const hourFmtCache = new Map<string, Intl.DateTimeFormat>()

/** YYYY-MM-DD formatter for a timezone ('en-CA' yields ISO-shaped dates). */
function dateFmt(tz: string): Intl.DateTimeFormat {
  let f = dateFmtCache.get(tz)
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz }); dateFmtCache.set(tz, f) }
  return f
}

/** 0-23 hour formatter for a timezone. */
function hourFmt(tz: string): Intl.DateTimeFormat {
  let f = hourFmtCache.get(tz)
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }); hourFmtCache.set(tz, f) }
  return f
}

/** Calendar date (YYYY-MM-DD) for an instant in a timezone, via the cached formatter. */
export function localDate(date: Date, tz: string): string {
  return dateFmt(tz).format(date)
}

/**
 * Given any ISO `dueAt` timestamp, returns the ISO timestamp for the START of
 * the logical day it falls in — i.e. `turnoverHour:00:00` in `tz` on the
 * same calendar day (or the previous day if the hour is before `turnoverHour`).
 *
 * Used to snap fractional-interval due dates so all cards due on a given day
 * appear simultaneously at day-start rather than trickling in throughout the day.
 */
export function snapDueAtToStartOfDay(
  dueAt:        string,
  tz:           string,
  turnoverHour: number,
): string {
  const date  = new Date(dueAt)
  // toLocaleString gives wall-clock time in `tz`; new Date() of that string uses
  // the system timezone for .getTime() but the correct wall-clock for .getHours()
  // / .getDate() — same trick as getToday().
  const local = new Date(date.toLocaleString('en-US', { timeZone: tz }))
  // Capture the (system_tz − target_tz) offset BEFORE any day mutation below — otherwise the
  // subtracted day corrupts it and pushes the result 24h late (a pre-turnover due date snapped
  // to the *next* study day instead of the current one).
  const offset = date.getTime() - local.getTime()
  const lHour = local.getHours()

  if (lHour < turnoverHour) local.setDate(local.getDate() - 1)

  const sy = local.getFullYear()
  const sm = String(local.getMonth() + 1).padStart(2, '0')
  const sd = String(local.getDate()).padStart(2, '0')
  const sh = String(turnoverHour).padStart(2, '0')

  // Apply the captured offset to the target local datetime (parsed as system time) to convert
  // it back to the correct UTC instant.
  const targetLocal = new Date(`${sy}-${sm}-${sd}T${sh}:00:00`)
  return new Date(targetLocal.getTime() + offset).toISOString()
}

/**
 * Converts an ISO timestamp to the local calendar date (YYYY-MM-DD) in the
 * given timezone, respecting the day turnover hour. Timestamps before
 * `turnoverHour` in local time are bucketed into the previous calendar day.
 */
export function localDateWithTurnover(isoTs: string, tz: string, turnoverHour: number): string {
  const date = new Date(isoTs)
  // Read the wall-clock hour + calendar date in `tz` via Intl (NOT `new Date(toLocaleString(...))`,
  // which Safari/WKWebView — the iOS app — parses unreliably, mis-bucketing graduations by a day so
  // "today's goals" never register as done). Mirrors getToday exactly, so both stay consistent.
  // Fast path: with no turnover the hour is irrelevant, so skip the hour formatter entirely.
  if (turnoverHour <= 0) return localDate(date, tz)
  const localHour = parseInt(hourFmt(tz).format(date), 10) % 24
  if (localHour < turnoverHour) {
    // Before turnover → count as the previous calendar day. Shift the timestamp 24h and re-format in tz
    // (handles month/year/DST boundaries), exactly as getToday does.
    return localDate(new Date(date.getTime() - 24 * 60 * 60 * 1000), tz)
  }
  return localDate(date, tz)
}

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
    const localHour = parseInt(hourFmt(tz).format(now), 10) % 24  // guard against "24" for midnight
    if (localHour < turnoverHour) {
      // It's before the turnover — treat as the previous calendar day
      return localDate(new Date(now.getTime() - 24 * 60 * 60 * 1000), tz)
    }
  }
  if (tz === 'UTC') return now.toISOString().slice(0, 10)
  return localDate(now, tz)
}
