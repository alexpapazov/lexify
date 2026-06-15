/**
 * engine/grading.ts
 * Pure functions for normalizing and grading typed answers.
 * No imports from React, Next.js, Supabase, or any I/O layer.
 */

import type { GradingSettings, GradingResult } from '@/domain'

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!
      } else {
        dp[i]![j] = 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
      }
    }
  }
  return dp[m]![n]!
}

function expandParentheticals(s: string): string[] {
  const match = /\(([^)]+)\)/.exec(s)
  if (!match) return [s]
  const withContent    = s.replace(/\(([^)]+)\)/, '$1').replace(/\s+/g, ' ').trim()
  const withoutContent = s.replace(/\([^)]+\)/, '').replace(/\s+/g, ' ').trim()
  return [withContent, withoutContent]
}

const ALL_ARTICLES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  "l'", 'le', 'les', 'des',
])

function stripLeadingArticle(s: string): string {
  const parts = s.split(/\s+/)
  if (parts.length > 1 && ALL_ARTICLES.has(parts[0]!.toLowerCase())) {
    return parts.slice(1).join(' ')
  }
  return s
}

export function normalizeAnswer(raw: string, settings: GradingSettings): string {
  let s = raw.trim()
  if (settings.caseInsensitive)    s = s.toLowerCase()
  if (settings.accentInsensitive)  s = stripAccents(s)
  if (settings.articleOptional)    s = stripLeadingArticle(s)
  return s
}

export function gradeTyping(
  userAnswer: string,
  expected:   string,
  settings:   GradingSettings,
): GradingResult {
  const normalizedUser = normalizeAnswer(userAnswer, settings)

  const slashParts = settings.acceptSlashAlternatives
    ? expected.split(/\s*\/\s*/)
    : [expected]

  let candidates: string[] = []
  for (const part of slashParts) {
    const expanded = settings.ignoreParentheticals
      ? expandParentheticals(part.trim())
      : [part.trim()]
    for (const variant of expanded) {
      candidates.push(normalizeAnswer(variant, settings))
    }
  }
  candidates = [...new Set(candidates)]

  if (candidates.some(c => c === normalizedUser)) {
    return { correct: true, normalizedUser, normalizedExpected: candidates[0]! }
  }

  if (settings.allowOneTypo && candidates.some(c => levenshtein(normalizedUser, c) <= 1)) {
    return { correct: true, normalizedUser, normalizedExpected: candidates[0]! }
  }

  return { correct: false, normalizedUser, normalizedExpected: candidates[0]! }
}

/**
 * Classifies how "wrong" a typed answer was, returning a severity score
 * from 0 (mild — close typo, spelling/accent slip, or article/gender slip)
 * to 1 (severe — blank answer or a totally different word). Used by the
 * long-term scheduler to scale how much a missed review shrinks the
 * card's interval.
 *
 * Only meaningful when `gradeTyping` already determined the answer is
 * incorrect — callers should not call this for correct answers.
 */
export function classifyWrongAnswer(
  userAnswer: string,
  expected:   string,
  settings:   GradingSettings,
): number {
  const normalizedUser     = normalizeAnswer(userAnswer, settings)
  const normalizedExpected = normalizeAnswer(expected, settings)

  // Blank / no attempt — total failure to produce the word.
  if (normalizedUser.length === 0) return 1.0

  // Article/gender-only mistake: stripping a leading article from both
  // sides makes them match, but they didn't match before stripping.
  const userNoArticle     = stripLeadingArticle(normalizedUser)
  const expectedNoArticle = stripLeadingArticle(normalizedExpected)
  if (userNoArticle === expectedNoArticle && normalizedUser !== normalizedExpected) {
    return 0.3
  }

  // Accent-only mistake: stripping accents from both sides makes them match,
  // but they didn't match before stripping (only relevant when
  // settings.accentInsensitive is false, since otherwise gradeTyping would
  // already consider this correct).
  if (
    normalizedUser !== normalizedExpected &&
    stripAccents(normalizedUser) === stripAccents(normalizedExpected)
  ) {
    return 0.05
  }

  const distance = levenshtein(normalizedUser, normalizedExpected)
  const maxLen   = Math.max(normalizedUser.length, normalizedExpected.length, 1)
  const ratio    = distance / maxLen

  // Close typo / spelling / accent slip.
  if (ratio <= 0.34) return 0.15

  // Essentially a different word.
  if (ratio >= 0.75) return 1.0

  // Moderate mismatch — partial recall.
  return 0.6
}

/**
 * True if a wrong typed answer represents a genuinely different word —
 * i.e. `classifyWrongAnswer`'s "essentially a different word" case — rather
 * than a close typo, spelling/accent slip, or article/gender slip. Blank
 * answers are not "a different word" (they're a non-attempt).
 *
 * Used to decide whether a mix-up is eligible to be tracked as a
 * `CardConfusion.isWordMixup` candidate for multiple-choice distractors
 * (see `lib/distractors.ts: promoteConfusionDistractor()`) — repeatedly
 * typing a *different real word* is a sign the two are easily confused,
 * whereas repeatedly mistyping the same word is not.
 */
export function isDifferentWordMistake(
  userAnswer: string,
  expected:   string,
  settings:   GradingSettings,
): boolean {
  const normalizedUser = normalizeAnswer(userAnswer, settings)
  if (normalizedUser.length === 0) return false
  return classifyWrongAnswer(userAnswer, expected, settings) >= 1.0
}
