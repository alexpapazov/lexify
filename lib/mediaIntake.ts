/**
 * lib/mediaIntake.ts — book-page intake, Stage 1 of features/Media Intake (proposal).md
 * (2026-11-05): photograph the pages you read, mark words the way you already do (circle,
 * underline, marginal line, question mark…), and Lexify parses the photos into cards — each with
 * the exact book sentence it was found in.
 *
 * Pipeline (every decision is the user's — see the proposal):
 *   A. EXTRACT fully from sliding page-pair windows (1+2, 2+3, …) so sentences crossing a page
 *      break are captured whole. Duplicates are welcome — re-marking a word is real signal.
 *   B. COLLAPSE automatically: same lemma + same sentence = one occurrence seen by two windows
 *      (dropped silently); same lemma + different sentences = genuinely re-marked → ONE candidate
 *      carrying all its sentences and a count.
 *   C. COMPARE against the lexicon by lemma (bare-front fallback): matches surface the existing
 *      card for a per-row action — skip / attach sentences / add anyway / replace.
 *
 * Wire types + the defensive parser live HERE because the client must never import from
 * app/api/** (the Capacitor trap); the route imports them from this file. Images are parsed and
 * discarded — nothing is stored but the extraction (v1 decision; no migration).
 */

import type { Card, Rating } from '@/domain'
import { displayText } from '@/lib/cardText'
import { stripGrammaticalTags, stripLeadingArticle } from '@/engine/grading'

/** The prompt-composition options snapshotted onto an entry at upload (Extraction Engine,
 *  2026-11-08). Circled/underlined are the ONLY marks (user decision) and everything is
 *  structured — no free text ever reaches a prompt. */
export interface IntakeOptions {
  circled:     boolean
  underlined:  boolean
  /** Capture marked words' sentences (requires the page-numbering pass, done server-side). */
  sentences:   boolean
  /** Nouns display with their definite article (French-style gender carding). */
  nounArticle: boolean
}

export const DEFAULT_OPTIONS: IntakeOptions = { circled: true, underlined: true, sentences: true, nounArticle: false }

/** Languages whose nouns are carded with a PRECEDING definite article — gates the
 *  "definite article" option in the upload form (Bulgarian's suffixed article doesn't count). */
export const ARTICLE_LANGS = new Set(['fr', 'es', 'it', 'pt', 'de', 'el', 'nl', 'en', 'ca', 'ro'])

/** One marked word/phrase as the vision model reports it, per window. */
export interface PageOccurrence {
  /** The word exactly as printed (and marked) on the page. */
  text:     string
  /** Dictionary citation form — what collapse and lexicon-compare key on. */
  lemma:    string
  kind:     'word' | 'phrase'
  /** Native meaning AS USED in this sentence — becomes the card's back. */
  gloss:    string
  /** The complete sentence it appears in (finished on the next page when it runs over).
   *  Empty when the entry was parsed with sentences off. */
  sentence: string
  marker:   string
  /** The flashcard form (noun with article when the option is on, infinitive, masc. sg.;
   *  phrases verbatim). Falls back to `text` for results parsed before this existed. */
  display?: string
}

/** Defensive parse of one window's `{ occurrences: [...] }` payload. Malformed entries drop
 *  individually; [] = nothing usable (the window just contributes nothing). */
export function parseOccurrences(raw: unknown): PageOccurrence[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { occurrences?: unknown }).occurrences
  if (!Array.isArray(list)) return []
  const out: PageOccurrence[] = []
  for (const o of list) {
    if (typeof o !== 'object' || o === null) continue
    const r = o as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    const gloss = typeof r.gloss === 'string' ? r.gloss.trim() : ''
    const sentence = typeof r.sentence === 'string' ? r.sentence.trim() : ''
    if (!text || !gloss) continue
    out.push({
      text,
      lemma: (typeof r.lemma === 'string' && r.lemma.trim()) ? r.lemma.trim() : text,
      kind: r.kind === 'phrase' ? 'phrase' : 'word',
      gloss,
      sentence,
      marker: typeof r.marker === 'string' ? r.marker.trim() : '',
      ...(typeof r.display === 'string' && r.display.trim() ? { display: r.display.trim() } : {}),
    })
  }
  return out
}

// ─── Stage B: collapse ─────────────────────────────────────────────────────────

export interface IntakeCandidate {
  /** The most common printed form among its occurrences. */
  text:      string
  /** The flashcard form (see PageOccurrence.display) — what a created card's front should be. */
  display?:  string
  lemma:     string
  kind:      'word' | 'phrase'
  gloss:     string
  /** Distinct sentences it was marked in, in reading order — each keeping the surface form THAT
   *  sentence used (inflections differ between markings; a stored cloze anchors on its answer). */
  sentences: { sentence: string; answer: string }[]
  /** How many DISTINCT markings (same-sentence re-sightings from window overlap don't count). */
  count:     number
  markers:   string[]
}

const normLemma = (s: string) => s.trim().toLowerCase()
/** Sentence identity for overlap-dropping: whitespace-collapsed, case-folded. */
const normSentence = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Stage B exactly as designed: window-overlap re-sightings vanish; true re-marks merge into one
 *  candidate with all its sentences and a count. Order = first appearance (reading order). */
export function collapseOccurrences(occurrences: PageOccurrence[]): IntakeCandidate[] {
  const byLemma = new Map<string, IntakeCandidate & { seenSentences: Set<string> }>()
  for (const o of occurrences) {
    const key = normLemma(o.lemma)
    const existing = byLemma.get(key)
    if (!existing) {
      byLemma.set(key, {
        text: o.text, lemma: o.lemma, kind: o.kind, gloss: o.gloss,
        ...(o.display ? { display: o.display } : {}),
        sentences: o.sentence ? [{ sentence: o.sentence, answer: o.text }] : [], count: 1,
        markers: o.marker ? [o.marker] : [],
        seenSentences: new Set(o.sentence ? [normSentence(o.sentence)] : []),
      })
      continue
    }
    const sKey = o.sentence ? normSentence(o.sentence) : ''
    if (sKey && existing.seenSentences.has(sKey)) continue   // the same occurrence, seen by two windows
    if (sKey) { existing.seenSentences.add(sKey); existing.sentences.push({ sentence: o.sentence, answer: o.text }) }
    existing.count += 1
    if (o.marker && !existing.markers.includes(o.marker)) existing.markers.push(o.marker)
    if (!existing.gloss && o.gloss) existing.gloss = o.gloss
    if (!existing.display && o.display) existing.display = o.display
  }
  return [...byLemma.values()].map(({ seenSentences: _s, ...c }) => c)
}

// ─── Stage C: compare against the lexicon ──────────────────────────────────────

export interface LexiconMatch {
  candidate: IntakeCandidate
  /** The existing card whose lemma (or bare front) matches — null = new to the lexicon. */
  existing:  Card | null
}

interface LexiconIndex {
  byLemma:     Map<string, Card>
  byBareFront: Map<string, Card>
}

/** Pair-scoped lemma + bare-front lookup maps — the one matching index both the marked-word
 *  compare and the unmarked-lemma split read from. */
function buildLexiconIndex(cards: Card[], sourceLanguage: string, targetLanguage: string): LexiconIndex {
  const byLemma = new Map<string, Card>()
  const byBareFront = new Map<string, Card>()
  for (const c of cards) {
    if (c.deletedAt || c.sourceLanguage !== sourceLanguage || c.targetLanguage !== targetLanguage) continue
    if (c.lemma && !byLemma.has(normLemma(c.lemma))) byLemma.set(normLemma(c.lemma), c)
    const bare = normLemma(stripLeadingArticle(stripGrammaticalTags(displayText(c.front)), c.sourceLanguage))
    if (bare && !byBareFront.has(bare)) byBareFront.set(bare, c)
  }
  return { byLemma, byBareFront }
}

function lookupLemma(idx: LexiconIndex, lemma: string, bareText: string): Card | null {
  return idx.byLemma.get(normLemma(lemma))
    ?? idx.byBareFront.get(normLemma(lemma))
    ?? (bareText ? idx.byBareFront.get(bareText) ?? idx.byLemma.get(bareText) ?? null : null)
}

/** Lemma-primary match with a bare-front fallback for unlabeled legacy cards. Only cards of the
 *  intake's language pair are considered (the caller passes its whole library). */
export function compareWithLexicon(
  candidates: IntakeCandidate[],
  cards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): LexiconMatch[] {
  const idx = buildLexiconIndex(cards, sourceLanguage, targetLanguage)
  return candidates.map(candidate => {
    const bare = normLemma(stripLeadingArticle(stripGrammaticalTags(candidate.text), sourceLanguage))
    return { candidate, existing: lookupLemma(idx, candidate.lemma, bare) }
  })
}

// ─── Stage D: every printed lemma (unmarked words are evidence too) ────────────

/** Defensive parse of a window's `allLemmas` array (same payload object as `occurrences`):
 *  strings only, trimmed, case-insensitively deduped, first-seen casing kept. */
export function parseAllLemmas(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { allLemmas?: unknown }).allLemmas
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of list) {
    if (typeof l !== 'string') continue
    const t = l.trim()
    if (!t || seen.has(normLemma(t))) continue
    seen.add(normLemma(t))
    out.push(t)
  }
  return out
}

/** Merge per-window lemma lists (windows overlap pages, so re-sightings are expected),
 *  then drop every MARKED lemma — what remains is the page's passive-knowledge evidence. */
export function unmarkedLemmas(windowLemmas: string[][], candidates: IntakeCandidate[]): string[] {
  const marked = new Set(candidates.map(c => normLemma(c.lemma)))
  const seen = new Set<string>()
  const out: string[] = []
  for (const window of windowLemmas) {
    for (const l of window) {
      const key = normLemma(l)
      if (!key || marked.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push(l)
    }
  }
  return out
}

// ─── Stage E: add-as-known chips ───────────────────────────────────────────────

/** The buckets a chip can be painted into (user design 2026-11-06). */
export type ChipBucket = 'short' | 'long' | 'dontknow'

/**
 * Due-date spread windows per known-bucket, in days from today (the shape `claimSpreadDay`
 * consumes). Short = "verify over the next ~2 weeks"; long = "~3 months" — the center sits
 * safely past LONG_TERM_THRESHOLD_DAYS, so a long-painted word is implicit-credit eligible
 * from day one.
 */
export const CHIP_WINDOWS: Record<'short' | 'long', { min: number; max: number; center: number }> = {
  short: { min: 2,  max: 14,  center: 7 },
  long:  { min: 80, max: 100, center: 90 },
}

/** The learning history each bucket stands in for (feeds `initialDifficulty`, same scale as
 *  onboarding bands: short ≈ "recognize it" (hard), long ≈ "know it cold" (easy)). */
export const CHIP_SEED_RATING: Record<'short' | 'long', Rating> = { short: 'hard', long: 'easy' }

/** Defensive parse of the gloss route's `{ glosses: [{ index, gloss }] }` payload → index → gloss. */
export function parseGlosses(raw: unknown): Map<number, string> {
  const out = new Map<number, string>()
  if (typeof raw !== 'object' || raw === null) return out
  const list = (raw as { glosses?: unknown }).glosses
  if (!Array.isArray(list)) return out
  for (const g of list) {
    if (typeof g !== 'object' || g === null) continue
    const r = g as Record<string, unknown>
    const gloss = typeof r.gloss === 'string' ? r.gloss.trim() : ''
    if (typeof r.index === 'number' && Number.isInteger(r.index) && r.index >= 0 && gloss) out.set(r.index, gloss)
  }
  return out
}

export interface UnmarkedSplit {
  /** Unmarked lemmas that map to a card of this pair — Stage B credit / Stage E chip targets. */
  known:   { lemma: string; card: Card }[]
  /** Unmarked lemmas with no card — Stage E add-as-known chip candidates. */
  unknown: string[]
}

/** Splits the unmarked lemmas against the lexicon with the SAME index the marked compare uses
 *  (lemma-primary, bare-front fallback, pair-scoped). */
export function splitUnmarkedLemmas(
  lemmas: string[],
  cards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): UnmarkedSplit {
  const idx = buildLexiconIndex(cards, sourceLanguage, targetLanguage)
  const known: UnmarkedSplit['known'] = []
  const unknown: string[] = []
  for (const lemma of lemmas) {
    const bare = normLemma(stripLeadingArticle(stripGrammaticalTags(lemma), sourceLanguage))
    const card = lookupLemma(idx, lemma, bare)
    if (card) known.push({ lemma, card })
    else unknown.push(lemma)
  }
  return { known, unknown }
}
