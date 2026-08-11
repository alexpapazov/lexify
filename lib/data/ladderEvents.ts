import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaged'
import type { UserId } from '@/domain'
import { isOfflineActive } from '@/lib/offline/mode'
import { localLogLadderEvent, localDeleteLadderEvent } from '@/lib/offline/localRepos'

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
  /** True when this attempt ran the branched pathway engine (from/to are STATE indices). */
  pathway?:        boolean
  /** Display name of the state the card landed in (pathway only) — lane labels in the replay. */
  stateName?:      string | null
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
    pathway:        !!r.pathway,
    stateName:      (r.state_name as string | null) ?? null,
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
      pathway: e.pathway ?? false, state_name: e.stateName ?? null,
    }))
    const { error } = await this.db.from('ladder_events').insert(rows)
    if (error) throw new Error(error.message)
  }

  /** Log one attempt and return its id (so undo can delete it → undo+redo counts once). */
  async log(userId: UserId, e: LadderEventInput): Promise<string | null> {
    if (isOfflineActive()) return localLogLadderEvent(e)
    const { data, error } = await this.db.from('ladder_events').insert({
      user_id: userId, session_id: e.sessionId, card_id: e.cardId, deck_id: e.deckId, label: e.label,
      source_language: e.sourceLanguage, target_language: e.targetLanguage,
      from_rung: e.fromRung, to_rung: e.toRung, rung_count: e.rungCount, rung_type: e.rungType,
      outcome: e.outcome, advanced: e.advanced, graduated: e.graduated, overridden: e.overridden, duration_ms: e.durationMs,
      pathway: e.pathway ?? false, state_name: e.stateName ?? null,
    }).select('id').single()
    if (error) throw new Error(error.message)
    return (data?.id as string) ?? null
  }

  async deleteById(id: string): Promise<void> {
    if (isOfflineActive()) return localDeleteLadderEvent(id)
    const { error } = await this.db.from('ladder_events').delete().eq('id', id)
    if (error) throw new Error(error.message)
  }

  /**
   * All of a user's ladder events, oldest-first (for grouping into sessions client-side).
   *
   * PAGED — the old `.limit(8000)` never lifted PostgREST's 1000-row cap, so this silently returned
   * the OLDEST thousand events forever: once a user's history passed 1000 attempts, every newer
   * session was invisible ("the logs stopped in July"). `fetchAllRows` walks `.range()` windows.
   */
  async listForUser(userId: UserId): Promise<LadderEvent[]> {
    const rows = await fetchAllRows<Record<string, unknown>>((from, to) =>
      this.db.from('ladder_events')
        .select('*').eq('user_id', userId).order('created_at', { ascending: true }).range(from, to))
    return rows.map(rowToEvent)
  }
}
