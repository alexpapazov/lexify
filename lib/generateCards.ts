/**
 * lib/generateCards.ts — chunked client for /api/cards/generate.
 *
 * The route answers in ONE model call and slices the result at MAX_CANDIDATE_CARDS (150). That was
 * invisible while the input cap was 1000 words, but onboarding raised it to 5000 so a whole frequency
 * list can be pasted — at which point an unchunked request returns 150 cards and silently discards
 * the rest. Every caller must go through here.
 *
 * Chunking differs by mode:
 *  - wordlist   — one line is one card, so chunk by LINES and stay well under the 150 cap.
 *  - extraction — running prose, so chunk by WORDS on line boundaries. Each chunk is mined for
 *    vocabulary independently, which can surface the same word twice; exact repeats are dropped.
 */

import { apiUrl } from '@/lib/apiBase'
import { mapLimit, chunk } from '@/lib/mapLimit'

/** Lines per wordlist request — half the route's 150-card ceiling, so a line that yields two cards
 *  (a split synonym, say) still can't hit it. */
const WORDLIST_LINES_PER_CHUNK = 75

/** Words per extraction request. Roughly the size that used to be the whole input cap, and well
 *  inside the response budget once the model has picked ~1 item per 6 words. */
const EXTRACTION_WORDS_PER_CHUNK = 600

/** Requests in flight. Same reasoning as the offline download's AI concurrency. */
const GENERATE_CONCURRENCY = 3

type LanguageWarning = 'front' | 'back' | 'both' | null

export interface GeneratedCard {
  front:           string
  back:            string
  languageWarning: LanguageWarning
}

export interface GenerateOptions {
  mode:                  'wordlist' | 'extraction'
  /** The pasted text — a word list or a passage, per `mode`. */
  input:                 string
  instructions:          string
  improvedTranslations?: boolean
  sourceLanguage:        string
  targetLanguage:        string
  /** Reports `(completedChunks, totalChunks)`; a single-chunk run reports once. */
  onProgress?:           (done: number, total: number) => void
}

export type GenerateResult =
  | { ok: true; cards: GeneratedCard[]; failedChunks: number }
  | { ok: false; reason: string }

/** Splits prose into chunks of ~`words` words without breaking a line in half. */
function chunkByWords(text: string, words: number): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let buf: string[] = []
  let count = 0
  for (const line of lines) {
    const n = line.trim() ? line.trim().split(/\s+/).length : 0
    if (count > 0 && count + n > words) {
      out.push(buf.join('\n'))
      buf = []
      count = 0
    }
    buf.push(line)
    count += n
  }
  if (buf.length > 0) out.push(buf.join('\n'))
  return out.filter(c => c.trim().length > 0)
}

function splitInput(mode: 'wordlist' | 'extraction', input: string): string[] {
  if (mode === 'wordlist') {
    const lines = input.split('\n').filter(l => l.trim().length > 0)
    return chunk(lines, WORDLIST_LINES_PER_CHUNK).map(c => c.join('\n'))
  }
  return chunkByWords(input, EXTRACTION_WORDS_PER_CHUNK)
}

/**
 * Runs the generation agent over the whole input, chunked.
 *
 * Returns `ok: false` only when EVERY chunk failed (so the caller can show the route's own reason).
 * A partial failure still returns the cards that worked, with `failedChunks` set — losing 75 of 1000
 * lines is worth reporting, not worth discarding the other 925 for.
 */
export async function generateCards(opts: GenerateOptions): Promise<GenerateResult> {
  const chunks = splitInput(opts.mode, opts.input)
  if (chunks.length === 0) return { ok: false, reason: 'empty-content' }

  let firstReason = 'api-error'
  const results = await mapLimit(chunks, GENERATE_CONCURRENCY, async piece => {
    const body = opts.mode === 'wordlist'
      ? { mode: 'wordlist', content: piece, instructions: opts.instructions, improvedTranslations: !!opts.improvedTranslations, sourceLanguage: opts.sourceLanguage, targetLanguage: opts.targetLanguage }
      : { mode: 'extraction', text: piece, instructions: opts.instructions, improvedTranslations: !!opts.improvedTranslations, sourceLanguage: opts.sourceLanguage, targetLanguage: opts.targetLanguage }
    const res = await fetch(apiUrl('/api/cards/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data?.ok || !Array.isArray(data.cards)) {
      if (typeof data?.reason === 'string') firstReason = data.reason
      throw new Error(firstReason)
    }
    return data.cards as GeneratedCard[]
  }, opts.onProgress)

  const failedChunks = results.filter(r => r === null).length
  if (failedChunks === chunks.length) return { ok: false, reason: firstReason }

  // Preserve input order (mapLimit keeps result slots), dropping exact repeats across chunks.
  const seen = new Set<string>()
  const cards: GeneratedCard[] = []
  for (const batch of results) {
    if (!batch) continue
    for (const c of batch) {
      const front = (c.front ?? '').trim()
      const back  = (c.back  ?? '').trim()
      if (!front || !back) continue
      const key = `${front.toLowerCase()}|||${back.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      cards.push({ front, back, languageWarning: c.languageWarning ?? null })
    }
  }

  if (cards.length === 0) return { ok: false, reason: 'parse-error' }
  return { ok: true, cards, failedChunks }
}
