import { createClient } from '@/lib/supabase/client'
import type { UserId } from '@/domain'

/** One logged rung attempt in a ladder study session. */
export interface LadderEventInput {
  sessionId:       string
  cardId:          string
  deckId:          string | null
  label:           string | null
  sourceLanguage:  string | null
  targetLanguage:  string | null
  fromRung:        number
  toRung:          number
  rungCount:       number
  rungType:        string | null
  outcome:         string | null
  advanced:        boolean
  graduated:       boolean
  overridden:      boolean
  durationMs:      number | null
}

export interface LadderEvent extends LadderEventInput {
  id:        string
  createdAt: string
}

function rowToEvent(r: Record<string, unknown>): LadderEvent {
  return {
    id:             r.id as string,
    sessionId:      r.session_id as string,
    cardId:         r.card_id as string,
    deckId:         (r.deck_id as string | null) ?? null,
    label:          (r.label as string | null) ?? null,
    sourceLanguage: (r.source_language as string | null) ?? null,
    targetLanguage: (r.target_language as string | null) ?? null,
    fromRung:       (r.from_rung as number) ?? 0,
    toRung:         (r.to_rung as number) ?? 0,
    rungCount:      (r.rung_count as number) ?? 1,
    rungType:       (r.rung_type as string | null) ?? null,
    outcome:        (r.outcome as string | null) ?? null,
    advanced:       !!r.advanced,
    graduated:      !!r.graduated,
    overridden:     !!r.overridden,
    durationMs:     (r.duration_ms as number | null) ?? null,
    createdAt:      r.created_at as string,
  }
}

export class SupabaseLadderEventRepository {
  private db = createClient()

  async logMany(userId: UserId, events: LadderEventInput[]): Promise<void> {
    if (events.length === 0) return
    const rows = events.map(e => ({
      user_id: userId, session_id: e.sessionId, card_id: e.cardId, deck_id: e.deckId, label: e.label,
      source_language: e.sourceLanguage, target_language: e.targetLanguage,
      from_rung: e.fromRung, to_rung: e.toRung, rung_count: e.rungCount, rung_type: e.rungType,
      outcome: e.outcome, advanced: e.advanced, graduated: e.graduated, overridden: e.overridden, duration_ms: e.durationMs,
    }))
    const { error } = await this.db.from('ladder_events').insert(rows)
    if (error) throw new Error(error.message)
  }

  /** All of a user's ladder events, oldest-first (for grouping into sessions client-side). */
  async listForUser(userId: UserId, limit = 8000): Promise<LadderEvent[]> {
    const { data, error } = await this.db.from('ladder_events')
      .select('*').eq('user_id', userId).order('created_at', { ascending: true }).limit(limit)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToEvent)
  }
}
