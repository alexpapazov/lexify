import { isOfflineActive } from './mode'

/** The device's own IANA timezone — authoritative for offline study (no server profile to read). */
export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/**
 * Resolve the user's `profiles` row. Offline (Capacitor / no connection) there's no server to read,
 * so return sensible local defaults — device timezone, no turnover, browser (device) audio — instead
 * of letting the Supabase call throw and break the page. Online, it just runs the passed query.
 *
 * Usage: `loadProfileRow(() => supabase.from('profiles').select('timezone, ...').eq('user_id', uid).single())`
 */
export function loadProfileRow(
  online: () => PromiseLike<{ data: Record<string, unknown> | null }>,
): Promise<{ data: Record<string, unknown> | null }> {
  if (isOfflineActive()) {
    return Promise.resolve({
      data: {
        timezone: deviceTimeZone(),
        day_turnover_hour: 0,
        audio_source_default: 'browser',
        audio_source_by_language: null,
        study_mode_autoplay: true,
        display_name: null,
        avatar_url: null,
        language_colors: null,
      },
    })
  }
  return Promise.resolve(online())
}
