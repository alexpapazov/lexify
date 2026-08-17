/**
 * lib/data/practiceAttempts.ts — the practice attempt log (migration 119).
 *
 * Write-only for now: every practice answer is filed — right or wrong, and what the learner
 * answered WITH when wrong — so a future feature starts with history instead of a cold start.
 * Nothing reads it yet, so there is no cached read to bust, and callers fire-and-forget: a failed
 * log line must never interrupt a session.
 */

import { createClient } from '@/lib/supabase/client'
import type { UserId } from '@/domain'

export interface PracticeAttemptInput {
  exercise: 'cloze' | 'matching'
  cardId:   string | null
  sourceLanguage: string
  targetLanguage: string
  /** Cloze: the sentence. Matching: the target word shown. */
  prompt:   string | null
  expected: string
  /** What the learner gave — the typed text, or the wrongly-paired tile's text. */
  response: string | null
  correct:  boolean
  overridden?: boolean
  /** Matching: the card whose tile they wrongly paired. */
  confusedCardId?: string | null
}

export class SupabasePracticeAttemptRepository {
  private get db() { return createClient() }

  async record(userId: UserId, a: PracticeAttemptInput): Promise<void> {
    const { error } = await this.db.from('practice_attempts').insert({
      user_id:          userId,
      exercise:         a.exercise,
      card_id:          a.cardId,
      source_language:  a.sourceLanguage,
      target_language:  a.targetLanguage,
      prompt:           a.prompt,
      expected:         a.expected,
      response:         a.response,
      correct:          a.correct,
      overridden:       a.overridden ?? false,
      confused_card_id: a.confusedCardId ?? null,
    })
    if (error) throw new Error(error.message)
  }
}
