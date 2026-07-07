/**
 * lib/hints.ts — "Hint" reveal logic for Due Now reviews.
 *
 * Computes what to reveal when the learner presses Hint on a graduated (due)
 * card, and how much to dampen the interval-growth multipliers as a result.
 *
 * Reveal levels:
 *  - Latin / Cyrillic / Greek (any alphabetic script): level 1 = first letter,
 *    level 2 = first two letters (never the whole word).
 *  - Korean (Hangul): a single level = the full first syllable block
 *    (안 → 안, 각 → 각). No hint at all for one-syllable words.
 *
 * The first letter/syllable is taken from the first CONTENT word — a leading
 * article ("el codo") is included in the autopopulated text (so grading still
 * matches) but the revealed letters count from the content word ("c…").
 *
 * Penalty (fraction of interval GROWTH retained, applied as
 * `1 + (multiplier - 1) * k`):
 *  - normal word:      level 1 → 0.65, level 2 → 0.40
 *  - short word (only one press possible because a second would reveal the
 *    whole answer — single-syllable Korean, ≤2-char word): → 0.35
 */

import { stripLeadingArticle } from '@/engine/grading'

const HANGUL_BASE = 0xac00
const HANGUL_END  = 0xd7a3

function isHangulSyllable(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return c >= HANGUL_BASE && c <= HANGUL_END
}

export interface HintPlan {
  /** Highest hint level available: 0 (no hint possible), 1, or 2. */
  maxLevel: number
  /**
   * True when the answer is short enough that even a level-1 reveal gives away
   * most of it (single-syllable Korean, ≤2-char word) — used for the penalty.
   */
  isShortWord: boolean
  /** levelText[i] = the full text to autopopulate for level i+1 (article + reveal). */
  levelText: string[]
}

/** Computes the reveal plan for an answer in the given answer language. */
export function hintPlan(answer: string, answerLanguage?: string): HintPlan {
  const empty: HintPlan = { maxLevel: 0, isShortWord: false, levelText: [] }
  const trimmed = (answer ?? '').trim()
  if (!trimmed) return empty

  // Split off a leading article so the *revealed* letters are the content word,
  // but keep the article in the autopopulated text so grading still matches.
  const content = stripLeadingArticle(trimmed, answerLanguage)
  if (!content) return empty
  const article = trimmed.length > content.length ? trimmed.slice(0, trimmed.length - content.length) : ''

  const chars = [...content]
  const first = chars[0]!

  // ── Korean (Hangul) ──────────────────────────────────────────────────────
  // One hint level only: reveal the FULL first syllable block (안 → 안, 각 → 각).
  // No hint for single-syllable words (it would give away the whole answer).
  if (isHangulSyllable(first)) {
    const syllableCount = chars.filter(isHangulSyllable).length
    if (syllableCount <= 1) return { maxLevel: 0, isShortWord: true, levelText: [] }
    // isShortWord=true for 2-syllable words (one block is half the answer → bigger penalty).
    return { maxLevel: 1, isShortWord: syllableCount === 2, levelText: [article + first] }
  }

  // ── Alphabetic (Latin / Cyrillic / Greek / …) ────────────────────────────
  const len = chars.length
  if (len <= 1) return { maxLevel: 0, isShortWord: true, levelText: [] }
  if (len === 2) return { maxLevel: 1, isShortWord: true, levelText: [article + chars[0]] }
  return {
    maxLevel: 2,
    isShortWord: false,
    levelText: [article + chars.slice(0, 1).join(''), article + chars.slice(0, 2).join('')],
  }
}

/**
 * Fraction of interval GROWTH retained when a hint was used at `level`
 * (0 = no hint → 1, no dampening). Passed to the scheduler as
 * `ScheduleContext.hintGrowthFactor`.
 */
export function hintGrowthFactor(level: number, isShortWord: boolean): number {
  if (level <= 0) return 1
  if (isShortWord) return 0.35
  return level >= 2 ? 0.40 : 0.65
}
