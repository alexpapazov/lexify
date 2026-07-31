/**
 * lib/duplicates.ts
 *
 * Pure helpers for the card-intake pipeline's two-tier duplicate detection
 * and for the input caps / pre-flight card-count estimate.
 *
 * Tier 1 (exact, silent): trim whitespace only, compare (front, back) as a
 * whole, case-sensitive.
 *
 * Tier 2 (near match, flagged): equal to an existing card once a leading
 * article/determiner is stripped from each side AND/OR the strings are
 * compared case-insensitively — e.g. "Matin"/"Morning" vs "matin"/"morning"
 * is a Tier-2 near match, not a silent Tier-1 merge.
 */

import type { Card } from '@/domain'
import { stripGrammaticalTags } from '@/engine/grading'

// ─── Input caps ──────────────────────────────────────────────────────────────

export const INSTRUCTIONS_CHAR_CAP = 3000

/**
 * Shared word-count cap for the main input box, in both wordlist and extraction modes.
 *
 * Sized for a whole frequency list (the 1000 most common words, with glosses). The AI-format path
 * CHUNKS its requests to stay under the per-response card cap — do not send an input this size to
 * `/api/cards/generate` in one call, or it truncates at MAX_CANDIDATE_CARDS and silently drops the
 * rest.
 */
export const INPUT_WORD_CAP = 5000

// ─── Normalization ───────────────────────────────────────────────────────────

/** Leading articles/determiners stripped during Tier-2 normalization, by language code. */
const LEADING_ARTICLES: Record<string, string[]> = {
  en: ['the', 'a', 'an'],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
  fr: ["l'", 'le', 'la', 'les', 'un', 'une', 'des'],
  it: ["l'", 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines'],
  nl: ['de', 'het', 'een'],
  ro: ['un', 'o', 'niște'],
  el: ['ο', 'η', 'το', 'οι', 'τα', 'ένας', 'μία', 'ένα'],
}

/** Tier 1: trim whitespace only (collapse internal runs of whitespace to a single space). No case changes. */
function normalizeTier1(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** Tier 2: Tier-1 normalization plus stripping one leading article/determiner for the given language. */
function normalizeTier2(s: string, langCode: string): string {
  const trimmed  = normalizeTier1(s)
  const articles = LEADING_ARTICLES[langCode] ?? []

  for (const article of articles) {
    if (article.endsWith("'")) {
      // Elision form, e.g. French "l'" — no space before the noun.
      const re = new RegExp(`^${escapeRegExp(article)}`, 'i')
      if (re.test(trimmed)) return trimmed.replace(re, '').trim()
    } else {
      const re = new RegExp(`^${escapeRegExp(article)}\\s+`, 'i')
      if (re.test(trimmed)) return trimmed.replace(re, '').trim()
    }
  }
  return trimmed
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Matching ────────────────────────────────────────────────────────────────

interface FrontBack { front: string; back: string }

/** Tier 1: exact match (whitespace-normalized) on both sides. */
export function tier1Match(a: FrontBack, b: FrontBack): boolean {
  return normalizeTier1(a.front) === normalizeTier1(b.front)
      && normalizeTier1(a.back)  === normalizeTier1(b.back)
}

/**
 * Tier 2: near match — equal once a leading article is stripped from each
 * side and/or the result is compared case-insensitively, but not already a
 * Tier-1 (exact, case-sensitive) match.
 */
export function tier2Match(a: FrontBack, b: FrontBack, sourceLanguage: string, targetLanguage: string): boolean {
  if (tier1Match(a, b)) return false
  return normalizeTier2(a.front, sourceLanguage).toLowerCase() === normalizeTier2(b.front, sourceLanguage).toLowerCase()
      && normalizeTier2(a.back,  targetLanguage).toLowerCase() === normalizeTier2(b.back,  targetLanguage).toLowerCase()
}

// ─── Duplicate analysis ──────────────────────────────────────────────────────

type DuplicateTier = 'exact' | 'near' | 'none'

export interface DuplicateAnalysis {
  tier:         DuplicateTier
  existingCard: Card | null
}

/**
 * Checks a candidate (front, back) against a user's existing cards in the
 * same language direction. Returns the strongest match found ('exact' wins
 * over 'near').
 */
export function analyzeDuplicate(
  candidate: FrontBack,
  existing: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): DuplicateAnalysis {
  let nearMatch: Card | null = null

  for (const card of existing) {
    if (tier1Match(candidate, card)) {
      return { tier: 'exact', existingCard: card }
    }
    if (!nearMatch && tier2Match(candidate, card, sourceLanguage, targetLanguage)) {
      nearMatch = card
    }
  }

  if (nearMatch) return { tier: 'near', existingCard: nearMatch }
  return { tier: 'none', existingCard: null }
}

// ─── Front-only matching (vocabulary onboarding) ─────────────────────────────
//
// Onboarding has a stricter rule than the two tiers above: a word you already have must NEVER be
// offered for rating, because rating it would create a second card for the same word with a
// self-assessed schedule, silently competing with the real one. So it matches on the FRONT alone
// (the word in the language being learned) and ignores the gloss entirely — "el pan"/"bread" and
// "el pan"/"loaf" are the same word, and only one of them belongs in the library.

/**
 * The comparison key for a front. Whitespace-collapsed, grammatical gender/number tags removed
 * ("la miel (f)" ≡ "la miel" — the tags are never graded either), one leading article stripped, and
 * lowercased.
 */
export function normalizeFrontKey(front: string, sourceLanguage: string): string {
  return normalizeTier2(stripGrammaticalTags(front), sourceLanguage).toLowerCase()
}

export interface FrontPartition<T> {
  /** Candidates whose front isn't in the library yet — these get onboarded. */
  fresh: T[]
  /** Candidates dropped as already-known, each with the library card it collided with. */
  skipped: { candidate: T; existing: Card }[]
}

/**
 * Splits candidates into the ones to onboard and the ones to drop.
 *
 * Also de-dupes WITHIN the candidate list (a frequency list can list the same lemma twice, and the
 * AI-format pass can emit the same front from two different lines) — the first occurrence wins and
 * later ones are reported against it, so the caller can show one honest "skipped" count.
 */
export function partitionExistingFronts<T extends { front: string }>(
  candidates:     T[],
  existing:       Card[],
  sourceLanguage: string,
): FrontPartition<T> {
  const byKey = new Map<string, Card>()
  for (const card of existing) {
    const key = normalizeFrontKey(card.front, sourceLanguage)
    if (key && !byKey.has(key)) byKey.set(key, card)
  }

  const fresh: T[] = []
  const skipped: { candidate: T; existing: Card }[] = []
  const seenInBatch = new Map<string, Card>()

  for (const candidate of candidates) {
    const key = normalizeFrontKey(candidate.front, sourceLanguage)
    // A front that normalizes to nothing can't be compared — let it through rather than silently
    // swallowing it; the create flow already drops genuinely blank fronts when parsing.
    if (!key) { fresh.push(candidate); continue }
    const hit = byKey.get(key) ?? seenInBatch.get(key)
    if (hit) { skipped.push({ candidate, existing: hit }); continue }
    fresh.push(candidate)
    // Stand-in for the not-yet-created card, so a repeat later in the same list is caught.
    seenInBatch.set(key, { front: candidate.front, back: '' } as Card)
  }

  return { fresh, skipped }
}

// ─── Pre-flight card-count estimate ─────────────────────────────────────────

type IntakeMode = 'wordlist' | 'extraction'

function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

/**
 * Cheap, client-side estimate of how many cards a request will produce —
 * shown to the user for confirmation before calling the AI agent.
 *
 * Word list mode: roughly one card per non-empty line.
 * Extraction mode: heuristic — roughly one vocabulary item per ~6 words of
 * running text, capped to the total word count.
 */
export function estimateCardCount(mode: IntakeMode, content: string): number {
  if (mode === 'wordlist') {
    return content.split('\n').map(l => l.trim()).filter(Boolean).length
  }
  const words = wordCount(content)
  if (words === 0) return 0
  return Math.max(1, Math.min(words, Math.round(words / 6)))
}
