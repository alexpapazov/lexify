/**
 * lib/distractors.ts
 *
 * Multiple-choice option builder for pre-graduation "recognition" steps.
 *
 * Strategy:
 *  1. Use cached `card.choices[side]` if it has enough usable distractors —
 *     return these immediately, synchronously.
 *  2. Otherwise, fill in with random front/back values from sibling cards in
 *     the deck so options can be shown right away with no loading delay.
 *  3. Separately (in the background), ask /api/distractors for AI-generated
 *     options (Claude) and cache the result on the card via
 *     cardRepo.update() once it resolves. Once cached, those AI choices are
 *     permanent and will be used immediately on future renders — the
 *     sibling-card fallback is only ever a temporary stand-in while AI
 *     choices are (re-)generated.
 *
 * Returns a shuffled array containing the correct answer plus up to
 * `OPTIONS_NEEDED - 1` distractors (fewer if the deck is too small).
 */

import type { Card, CardSide, CardChoices, CardConfusion } from '@/domain'
import { apiUrl } from '@/lib/apiBase'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { langName, TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'
import { displayText } from '@/lib/cardText'
import { getAudioSourceForLanguage } from '@/lib/speak'

export const OPTIONS_NEEDED = 4

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Returns the {id, answer} pairs of every other card in `deckCards` that has
 * the same prompt-side value as `card` — e.g. if "el camarón" and "la gamba"
 * both have back="shrimp", each is a sibling of the other. The id lets the
 * session credit the sibling card as well as requiring the canonical answer.
 */
export function deckSiblings(
  card:      Card,
  answerSide: CardSide,
  deckCards: Card[],
): { id: string; answer: string }[] {
  if (answerSide === 'front') {
    const target = norm(card.back)
    return deckCards
      .filter(c => c.id !== card.id && norm(c.back) === target)
      .map(c => ({ id: c.id, answer: c.front }))
  } else {
    const target = norm(card.front)
    return deckCards
      .filter(c => c.id !== card.id && norm(c.front) === target)
      .map(c => ({ id: c.id, answer: c.back }))
  }
}

function dedupeAgainst(correct: string, pool: string[]): string[] {
  const seen = new Set([norm(correct)])
  const out: string[] = []
  for (const item of pool) {
    const key = norm(item)
    if (!item.trim() || seen.has(key)) continue
    seen.add(key)
    out.push(item.trim())
  }
  return out
}

/**
 * Returns true if `candidate` is likely a synonym / near-form of `correct`
 * and should therefore NOT appear as a distractor. Heuristics:
 *  - One contains the other (e.g. "puppy" / "puppy dog")
 *  - Same first N characters (e.g. "pup" / "puppy")
 */
function isPotentialSynonym(correct: string, candidate: string): boolean {
  const nc = norm(correct)
  const nd = norm(candidate)
  if (nc === nd) return true
  if (nc.includes(nd) || nd.includes(nc)) return true
  // Shared prefix of length ≥ 3 (catches "pup" / "puppy", "auto" / "automobile")
  const prefixLen = Math.min(nc.length, nd.length)
  if (prefixLen >= 3 && nc.slice(0, prefixLen) === nd.slice(0, prefixLen)) return true
  return false
}

/** Random sibling-card fallback: pull `count` other values from `side` of other cards in the deck.
 *  Filters out values that look like synonyms of the correct answer.
 *  `excludeNorms` is an optional set of already-normalised texts to skip (e.g. synonym-group members). */
function deckFallback(card: Card, side: CardSide, deckCards: Card[], correct: string, count: number, excludeNorms?: Set<string>): string[] {
  const pool = deckCards
    .filter(c => c.id !== card.id)
    .map(c => displayText(side === 'front' ? c.front : c.back))
    .filter(v => !isPotentialSynonym(correct, v))
    .filter(v => !excludeNorms?.has(norm(v)))
  return shuffle(dedupeAgainst(correct, pool)).slice(0, count)
}

async function fetchAiChoices(
  card: Card,
  deckCards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
  avoidFrontExtra?: string[],
  avoidBackExtra?: string[],
): Promise<CardChoices | null> {
  try {
    const res = await fetch(apiUrl('/api/distractors'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        front: card.front,
        back:  card.back,
        sourceLanguage: langName(sourceLanguage),
        targetLanguage: langName(targetLanguage),
        deckFronts: deckCards.filter(c => c.id !== card.id).map(c => c.front),
        deckBacks:  deckCards.filter(c => c.id !== card.id).map(c => c.back),
        ...(avoidFrontExtra?.length ? { avoidFrontExtra } : {}),
        ...(avoidBackExtra?.length  ? { avoidBackExtra  } : {}),
      }),
    })
    const data = await res.json()
    if (!data.ok || !data.choices) return null
    return data.choices as CardChoices
  } catch {
    return null
  }
}

/**
 * Build multiple-choice options for `side` of `card` synchronously, with no
 * network calls. Uses cached AI choices if there are enough; otherwise pads
 * out with random sibling-card values from the deck as a temporary stand-in.
 * `side` is the answer side of the current pipeline step — i.e. what the
 * learner needs to pick out from among the distractors.
 */
/**
 * Build multiple-choice options for `side` of `card` synchronously.
 * `excludeTexts` — additional answer texts to exclude from the distractor pool,
 * used for synonym-group cards whose other members are also correct answers.
 */
/**
 * True when a distractor mixes scripts (e.g. Cyrillic stem + Latin word like
 * "тронClassifications") — an AI-generation artifact that should never be shown.
 * A word legitimately in one script won't trip this; only Cyrillic/Greek + Latin does.
 */
function looksMalformed(text: string): boolean {
  const hasLatin    = /[A-Za-z]/.test(text)
  const hasCyrillic = /[Ѐ-ӿ]/.test(text)
  const hasGreek    = /[Ͱ-Ͽ]/.test(text)
  return hasLatin && (hasCyrillic || hasGreek)
}

/** The dominant writing system of a word, ignoring parenthetical annotations like "(m)"/"(n)". */
function primaryScript(text: string): string {
  const t = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
  const counts: Record<string, number> = {
    latin:    (t.match(/[A-Za-zÀ-ÿ]/g)                 || []).length,
    cyrillic: (t.match(/[Ѐ-ӿ]/g)             || []).length,
    greek:    (t.match(/[Ͱ-Ͽἀ-῿]/g) || []).length,
    cjk:      (t.match(/[぀-ヿ㐀-鿿]/g) || []).length,   // kana + Han (Japanese/Chinese)
    hangul:   (t.match(/[가-힯ᄀ-ᇿ]/g) || []).length,   // Korean
    arabic:   (t.match(/[؀-ۿ]/g)             || []).length,
  }
  let best = '', max = 0
  for (const k in counts) if (counts[k]! > max) { max = counts[k]!; best = k }
  return best
}

/**
 * True when a distractor is written in the same script as the correct answer (or either has no
 * letters). Blocks cross-language leakage the mixed-script check misses — e.g. a CJK word like
 * "状態" appearing among Cyrillic (Bulgarian) options.
 */
export function scriptMatches(correct: string, distractor: string): boolean {
  const a = primaryScript(correct), b = primaryScript(distractor)
  return !a || !b || a === b
}

export function buildOptions(
  card: Card,
  side: CardSide,
  deckCards: Card[],
  excludeTexts?: string[],
): string[] {
  const correct = displayText(side === 'front' ? card.front : card.back)
  const synonyms = (side === 'front' ? card.choices?.frontSynonyms : card.choices?.backSynonyms) ?? []
  const distractorsNeeded = OPTIONS_NEEDED - 1
  const excludeNorms = new Set((excludeTexts ?? []).map(norm))

  // Filter out synonyms, excluded texts, malformed (mixed-script) distractors, AND any distractor
  // in a different script from the answer (cross-language leakage, e.g. a CJK word among Cyrillic).
  const cachedFiltered = (card.choices?.[side] ?? []).filter(d =>
    !synonyms.some(s => norm(s) === norm(d)) && !excludeNorms.has(norm(d)) && !looksMalformed(d) && scriptMatches(correct, d)
  )

  let pool = dedupeAgainst(correct, cachedFiltered)
  if (pool.length < distractorsNeeded) {
    const fallback = deckFallback(card, side, deckCards, correct, distractorsNeeded - pool.length, excludeNorms)
    pool = dedupeAgainst(correct, [...pool, ...fallback])
  }

  const distractors = shuffle(pool).slice(0, distractorsNeeded)
  return shuffle([correct, ...distractors])
}

/** True if `card` still needs AI/cached distractors generated for `side`. */
export function needsChoices(card: Card, side: CardSide): boolean {
  const correct = displayText(side === 'front' ? card.front : card.back)
  const pool = dedupeAgainst(correct, card.choices?.[side] ?? [])
  return pool.length < OPTIONS_NEEDED - 1
}

/**
 * If `card` doesn't yet have enough cached AI distractors for `side`, fetch
 * fresh ones from /api/distractors and cache them on the card for good.
 * Returns the newly cached choices (covering both sides), or `null` if no
 * generation was needed or it failed — in which case the caller keeps
 * showing its existing/fallback options and can simply try again later.
 */
export async function ensureChoicesGenerated(
  card: Card,
  side: CardSide,
  deckCards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
): Promise<CardChoices | null> {
  if (!needsChoices(card, side)) return null

  const aiChoices = await fetchAiChoices(card, deckCards, sourceLanguage, targetLanguage)
  if (!aiChoices) return null

  try {
    const cardRepo = new SupabaseCardRepository()
    await cardRepo.update(card.id, { choices: aiChoices })
  } catch {
    // Caching is best-effort — the caller still gets the freshly generated choices.
  }
  return aiChoices
}

/**
 * Clears all cached distractors for one side of a card and regenerates them,
 * explicitly excluding the old (bad) distractors from the AI prompt.
 *
 * Used when the learner deletes every distractor on one side — a signal that
 * the entire set was poor quality and should not be reused.
 *
 * Saves the fresh result to the DB (best-effort) and returns it, or null on failure.
 */
export async function regenerateChoicesExcluding(
  card: Card,
  deckCards: Card[],
  sourceLanguage: string,
  targetLanguage: string,
  excludedFront: string[],
  excludedBack: string[],
): Promise<CardChoices | null> {
  const aiChoices = await fetchAiChoices(card, deckCards, sourceLanguage, targetLanguage, excludedFront, excludedBack)
  if (!aiChoices) return null
  try {
    const cardRepo = new SupabaseCardRepository()
    await cardRepo.update(card.id, { choices: aiChoices })
  } catch {
    // Caching is best-effort — the caller still gets the freshly generated choices.
  }
  return aiChoices
}

/**
 * Number of times a learner must mix up the same word with a card's answer
 * (see `CardConfusion.count`/`isWordMixup`) before that word gets promoted
 * into the card's cached multiple-choice distractors.
 */
const CONFUSION_PROMOTION_THRESHOLD = 3

/**
 * If the learner has repeatedly (>= CONFUSION_PROMOTION_THRESHOLD times)
 * confused a real word with `card`'s `side` answer — and that word isn't
 * already one of `card`'s cached distractors for `side` — returns updated
 * `CardChoices` with the confused word swapped in for the lowest-priority
 * existing distractor (the last one). Returns `null` if there's nothing to
 * promote, or if `card.choices[side]` doesn't yet have a full cached
 * distractor set to swap from (in that case the AI-generation path will
 * populate it first; promotion can happen on a later session).
 *
 * Pure/synchronous — callers are responsible for persisting the result
 * (see `promoteConfusionDistractors`).
 */
export function promoteConfusionDistractor(
  card: Card,
  side: CardSide,
  confusions: CardConfusion[],
): CardChoices | null {
  const correct = side === 'front' ? card.front : card.back
  const distractorsNeeded = OPTIONS_NEEDED - 1

  const current = dedupeAgainst(correct, card.choices?.[side] ?? [])
  if (current.length < distractorsNeeded) return null

  const best = confusions
    .filter(c => c.answerSide === side && c.isWordMixup && c.count >= CONFUSION_PROMOTION_THRESHOLD)
    .filter(c => norm(c.confusedText) !== norm(correct))
    .filter(c => scriptMatches(correct, c.confusedText))   // don't promote a cross-language mix-up
    .sort((a, b) => b.count - a.count)[0]
  if (!best) return null

  const confusedText = best.confusedText.trim()
  if (!confusedText) return null
  if (current.some(x => norm(x) === norm(confusedText))) return null // already a distractor

  const updated = [...current.slice(0, distractorsNeeded - 1), confusedText]
  const base: CardChoices = card.choices ?? { front: [], back: [] }
  return { ...base, [side]: updated }
}

/**
 * Force a SPECIFIC word into `card.choices[side]` as a distractor — used for confusion links, so the
 * confused partner word shows up in this card's recognition MCQ. Swaps into the last slot when the
 * pool is full, else appends. Returns updated `CardChoices`, or `null` if it's already a distractor,
 * equals the correct answer, or is blank. Pure — caller persists.
 */
export function injectForcedDistractor(card: Card, side: CardSide, word: string): CardChoices | null {
  const correct = side === 'front' ? card.front : card.back
  const w = word.trim()
  if (!w || norm(w) === norm(correct)) return null
  const distractorsNeeded = OPTIONS_NEEDED - 1
  const current = dedupeAgainst(correct, card.choices?.[side] ?? [])
  if (current.some(x => norm(x) === norm(w))) return null            // already a distractor
  const base: CardChoices = card.choices ?? { front: [], back: [] }
  const updated = current.length < distractorsNeeded
    ? [...current, w]                                                 // partial pool → append
    : [...current.slice(0, distractorsNeeded - 1), w]                 // full pool → swap last
  return { ...base, [side]: updated }
}

export interface ConfusionPromotionItem {
  card: Card
  side: CardSide
}

/**
 * Background pass over upcoming recognition-step cards: for each one, checks
 * whether a frequently-confused word should be promoted into its cached
 * distractors (`promoteConfusionDistractor`), and if so persists the updated
 * `choices` via `cardRepo.update()` and reports it through `onCached` (same
 * callback shape as `prefetchChoices`/`ensureChoicesGenerated`) so the
 * session can update its in-memory card immediately. Best-effort — failures
 * are swallowed per-card.
 */
export async function promoteConfusionDistractors(
  items: ConfusionPromotionItem[],
  confusionsByCard: Map<string, CardConfusion[]>,
  onCached: (cardId: string, choices: CardChoices) => void,
): Promise<void> {
  const cardRepo = new SupabaseCardRepository()
  for (const { card, side } of items) {
    const confusions = confusionsByCard.get(card.id) ?? []
    if (confusions.length === 0) continue
    const updated = promoteConfusionDistractor(card, side, confusions)
    if (!updated) continue
    try {
      await cardRepo.update(card.id, { choices: updated })
      onCached(card.id, updated)
    } catch {
      // Best-effort — try again on a future session.
    }
  }
}

interface AudioPrefetchItem {
  card:           Card
  sourceLanguage: string
}

/**
 * Background pre-generation of TTS audio for cards that don't have it yet.
 * Separate from prefetchChoices so it covers typing steps and graduated cards
 * that don't need distractor generation. Runs with limited concurrency and
 * fails silently per-card.
 */
export async function prefetchAudio(
  items: AudioPrefetchItem[],
  onAudioCached: (cardId: string, audioData: string) => void,
  concurrency = 2,
): Promise<void> {
  const toFetch = items.filter(it => !it.card.audioGenerated && TTS_SUPPORTED_LANGUAGES.has(it.sourceLanguage))
  if (toFetch.length === 0) return
  let next = 0
  async function worker() {
    while (next < toFetch.length) {
      const item = toFetch[next++]
      if (!item) continue
      await fetchAndCacheAudio(item.card, item.sourceLanguage, onAudioCached)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toFetch.length) }, worker))
}

export interface PrefetchItem {
  card:           Card
  side:           CardSide
  deckCards:      Card[]
  sourceLanguage: string
  targetLanguage: string
}

async function fetchAndCacheAudio(
  card: Card,
  sourceLanguage: string,
  onAudioCached: (cardId: string, audioData: string) => void,
): Promise<void> {
  if (card.audioGenerated || !TTS_SUPPORTED_LANGUAGES.has(sourceLanguage)) return
  const src = getAudioSourceForLanguage(sourceLanguage)
  if (src === 'browser') return   // robotic default → nothing to pre-generate; playback uses on-device speech
  try {
    const res = await fetch(apiUrl('/api/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Use the chosen default source; Forvo auto-falls back to ElevenLabs when it has no recording.
      body: JSON.stringify({ text: card.front, language: sourceLanguage, source: src, fallback: src === 'forvo' }),
    })
    const data = await res.json()
    if (!data.ok || !data.audioData) return
    const cardRepo = new SupabaseCardRepository()
    await cardRepo.update(card.id, { audioGenerated: true, audioData: data.audioData })
    onAudioCached(card.id, data.audioData)
  } catch {
    // Best-effort — card will still show without AI audio.
  }
}

/**
 * Background pre-generation of multiple-choice distractors for upcoming
 * session cards, so `MultipleChoiceMode` rarely has to show "Loading
 * choices…" — by the time a card comes up, its options are usually already
 * cached. Also co-triggers TTS audio generation for cards that don't have it yet.
 * Runs with limited concurrency and fails silently per-card.
 */
export async function prefetchChoices(
  items: PrefetchItem[],
  onCached: (cardId: string, choices: CardChoices) => void,
  concurrency = 2,
  onAudioCached?: (cardId: string, audioData: string) => void,
): Promise<void> {
  let next = 0
  async function worker() {
    while (next < items.length) {
      const item = items[next++]
      if (!item) continue
      try {
        const [aiChoices] = await Promise.all([
          ensureChoicesGenerated(item.card, item.side, item.deckCards, item.sourceLanguage, item.targetLanguage),
          onAudioCached ? fetchAndCacheAudio(item.card, item.sourceLanguage, onAudioCached) : Promise.resolve(),
        ])
        if (aiChoices) onCached(item.card.id, aiChoices)
      } catch {
        // Best-effort — the card will fall back to deck-based choices when shown.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}
