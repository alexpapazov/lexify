/**
 * lib/duplicates.ts
 *
 * Pure helpers for the card-intake pipeline's two-tier duplicate detection
 * and for the input caps / pre-flight card-count estimate.
 *
 * Tier 1 (exact, silent): trim whitespace only, compare (front, back) as a
 * whole. No lowercasing — capitalization is meaningful (Milestone 1 spec).
 *
 * Tier 2 (near match, flagged): additionally strip a leading article /
 * determiner (only the article token is compared case-insensitively; the
 * rest of the string keeps its original case).
 */

import type { Card } from '@/domain'

// ─── Input caps ──────────────────────────────────────────────────────────────

export const WORDLIST_CHAR_CAP     = 500
export const INSTRUCTIONS_CHAR_CAP = 500
export const EXTRACTION_WORD_CAP   = 500

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
export function normalizeTier1(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** Tier 2: Tier-1 normalization plus stripping one leading article/determiner for the given language. */
export function normalizeTier2(s: string, langCode: string): string {
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

export interface FrontBack { front: string; back: string }

/** Tier 1: exact match (whitespace-normalized) on both sides. */
export function tier1Match(a: FrontBack, b: FrontBack): boolean {
  return normalizeTier1(a.front) === normalizeTier1(b.front)
      && normalizeTier1(a.back)  === normalizeTier1(b.back)
}

/** Tier 2: near match — equal once a leading article is stripped from each side, but not already a Tier-1 match. */
export function tier2Match(a: FrontBack, b: FrontBack, sourceLanguage: string, targetLanguage: string): boolean {
  if (tier1Match(a, b)) return false
  return normalizeTier2(a.front, sourceLanguage) === normalizeTier2(b.front, sourceLanguage)
      && normalizeTier2(a.back,  targetLanguage) === normalizeTier2(b.back,  targetLanguage)
}

// ─── Duplicate analysis ──────────────────────────────────────────────────────

export type DuplicateTier = 'exact' | 'near' | 'none'

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

// ─── Pre-flight card-count estimate ─────────────────────────────────────────

export type IntakeMode = 'wordlist' | 'extraction'

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
