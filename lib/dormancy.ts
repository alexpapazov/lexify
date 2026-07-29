/**
 * lib/dormancy.ts — keeping the two directions' dormancy in step.
 *
 * Dormancy is PER-DIRECTION: Due Now gates the forward (production) row and the reverse
 * (recognition) row on their own `dormant` flags, so either can be paused and resumed
 * independently. That independence is the point — "Resume recognition" on a dormant card used to be
 * a no-op because the forward flag suppressed reverse too.
 *
 * But the two places that pause a card WHOLESALE still have to set both rows:
 *  - the ℹ panel's "Make dormant now" (calls setDormancy(..., 'all') directly), and
 *  - auto-dormancy, which fires after a production review once reps >= dormancyThreshold. That path
 *    only ever wrote the forward row; with the master switch gone it would leave recognition running,
 *    which is NOT what "go dormant after N reviews" means.
 */

import { SupabaseCardStateRepository } from '@/lib/data/cardStates'

/**
 * Mirrors an auto-dormancy trigger onto the card's reverse row. Best-effort and fire-and-forget:
 * throws when the card has no reverse row (the common single-direction case) and offline, where
 * `setDormancy` has no local-store path — both are swallowed. The forward row is already persisted
 * by the caller's own upsert, so a failure here only means recognition stays active.
 */
export function markReverseDormant(userId: string, cardId: string): void {
  void new SupabaseCardStateRepository()
    .setDormancy(userId, cardId, { dormant: true }, 'reverse')
    .catch(() => {})
}
