import { createClient } from '@/lib/supabase/client'
import { apiUrl } from '@/lib/apiBase'

/**
 * Fire-and-forget: tells the server to fill any pending blank synced cards for
 * the current user. Safe to call from any client component — gets its own
 * session token internally. No-ops immediately if the user has no session.
 *
 * Call whenever deck.syncingComplete === false:
 *   - deck detail page loads
 *   - study session starts
 *   - a card is saved inside a synced deck
 */
export function triggerSyncFill(): void {
  const supabase = createClient()
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session?.access_token) return
    fetch(apiUrl('/api/sync'), {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ fillPending: true, cards: [] }),
    }).catch(() => {})
  })
}
