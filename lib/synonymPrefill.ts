/**
 * lib/synonymPrefill.ts
 *
 * Persists which synonym-group cards the learner answered correctly today,
 * so their typing boxes appear pre-grayed in subsequent sessions on the
 * same study day.  Resets at the configured day-turnover hour.
 *
 * Storage: localStorage key `syn_prefill_{userId}_{studyDayKey}`
 * where studyDayKey = getToday(tz, turnoverHour).
 */

const PREFIX = 'syn_prefill'

function storageKey(userId: string, studyDayKey: string): string {
  return `${PREFIX}_${userId}_${studyDayKey}`
}

export function markSynonymAnswered(
  userId: string,
  cardId: string,
  studyDayKey: string,
): void {
  if (typeof window === 'undefined') return
  const key = storageKey(userId, studyDayKey)
  try {
    const raw = localStorage.getItem(key)
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : []
    if (!ids.includes(cardId)) {
      ids.push(cardId)
      localStorage.setItem(key, JSON.stringify(ids))
    }
  } catch { /* ignore quota errors */ }
}

export function wasSynonymAnswered(
  userId: string,
  cardId: string,
  studyDayKey: string,
): boolean {
  if (typeof window === 'undefined') return false
  const key = storageKey(userId, studyDayKey)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return false
    return (JSON.parse(raw) as string[]).includes(cardId)
  } catch {
    return false
  }
}

/**
 * Removes a card from today's "answered" set. Used when a synonym group
 * completes a full round (every form typed correctly) but the pipeline step
 * still needs more correct repetitions — the grey-out must reset so the next
 * round re-prompts every form.
 */
export function unmarkSynonymAnswered(
  userId: string,
  cardId: string,
  studyDayKey: string,
): void {
  if (typeof window === 'undefined') return
  const key = storageKey(userId, studyDayKey)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return
    const ids = (JSON.parse(raw) as string[]).filter(id => id !== cardId)
    if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids))
    else localStorage.removeItem(key)
  } catch { /* ignore */ }
}

/** Removes localStorage keys for past study days to prevent unbounded growth. */
export function purgeStaleSynonymPrefill(
  userId: string,
  studyDayKey: string,
): void {
  if (typeof window === 'undefined') return
  const current = storageKey(userId, studyDayKey)
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(`${PREFIX}_${userId}_`) && k !== current) {
      localStorage.removeItem(k)
    }
  }
}
