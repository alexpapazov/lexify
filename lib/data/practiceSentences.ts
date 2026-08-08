/**
 * lib/data/practiceSentences.ts — the practice sentence bank (migration 113).
 *
 * Cached cloze exercises keyed by (user, language pair, target lemma), so repeat practice over the
 * same words costs no generation calls.
 *
 * NOT cached through `readCache`: the bank is written on every session (new sentences saved, use
 * counts bumped), and serving a 60-second-stale list would hand out the same sentences twice in a
 * row — which is exactly what `use_count` exists to prevent.
 *
 * ONLINE ONLY, like the rest of practice mode.
 */

import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabasePaged'
import type { PracticeExercise } from '@/lib/practiceSchema'
import type { UserId } from '@/domain'

export interface StoredSentence {
  id:          string
  targetLemma: string
  exercise:    PracticeExercise
  useCount:    number
}

function rowToStored(row: Record<string, unknown>): StoredSentence {
  return {
    id:          row.id as string,
    targetLemma: row.target_lemma as string,
    exercise:    row.exercise as PracticeExercise,
    useCount:    (row.use_count as number | null) ?? 0,
  }
}

export class SupabasePracticeSentenceRepository {
  private get db() { return createClient() }

  /**
   * Every stored sentence for the given lemmas, least-used first so the caller naturally rotates
   * through the bank rather than replaying one sentence. Chunked on the lemma list and paged — a
   * deck-sized session can ask about hundreds of words.
   */
  async listForLemmas(
    userId: UserId, sourceLanguage: string, targetLanguage: string, lemmas: string[],
  ): Promise<StoredSentence[]> {
    if (lemmas.length === 0) return []
    const out: StoredSentence[] = []
    const CHUNK = 200
    for (let i = 0; i < lemmas.length; i += CHUNK) {
      const slice = lemmas.slice(i, i + CHUNK)
      const rows = await fetchAllRows<Record<string, unknown>>((from, to) => this.db
        .from('practice_sentences')
        .select('id, target_lemma, exercise, use_count')
        .eq('user_id', userId)
        .eq('source_language', sourceLanguage)
        .eq('target_language', targetLanguage)
        .in('target_lemma', slice)
        .order('use_count').order('created_at').order('id')
        .range(from, to))
      out.push(...rows.map(rowToStored))
    }
    return out
  }

  /** Files freshly generated sentences. Best-effort: a failed save costs a cache entry, not a session. */
  async saveMany(
    userId: UserId, sourceLanguage: string, targetLanguage: string,
    entries: { targetLemma: string; exercise: PracticeExercise }[],
  ): Promise<void> {
    if (entries.length === 0) return
    const rows = entries.map(e => ({
      user_id: userId,
      source_language: sourceLanguage,
      target_language: targetLanguage,
      target_lemma: e.targetLemma,
      exercise: e.exercise,
    }))
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await this.db.from('practice_sentences').insert(rows.slice(i, i + CHUNK))
      if (error) throw new Error(error.message)
    }
  }

  /**
   * Bumps `use_count` for the sentences a session actually served, so the next session reaches for
   * different ones. Read-modify-write rather than an RPC: the counts are advisory (they only affect
   * ordering), so a lost increment costs a repeated sentence, not correctness.
   */
  async markUsed(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const { data, error } = await this.db.from('practice_sentences')
      .select('id, use_count').in('id', ids)
    if (error) throw new Error(error.message)
    const now = new Date().toISOString()
    await Promise.all((data ?? []).map(row => this.db.from('practice_sentences')
      .update({ use_count: ((row.use_count as number | null) ?? 0) + 1, last_used_at: now })
      .eq('id', row.id as string)))
  }

  /** Drops stored sentences for a lemma — used when a card's text changes under it. */
  async deleteForLemma(
    userId: UserId, sourceLanguage: string, targetLanguage: string, targetLemma: string,
  ): Promise<void> {
    const { error } = await this.db.from('practice_sentences').delete()
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('target_lemma', targetLemma)
    if (error) throw new Error(error.message)
  }
}
