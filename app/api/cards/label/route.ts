/**
 * POST /api/cards/label
 *
 * Practice-mode groundwork: label a batch of cards with the part of speech and dictionary lemma of
 * their FRONT (the learned-language side). The labels are what later lets practice-mode generation
 * ask "does this library have verbs?", filter replacement candidates by word class, and check
 * generated sentences against the library by lemma instead of by surface form.
 *
 * The back (native gloss) is sent ONLY as a disambiguation hint — "pesca"/"peach" is a noun,
 * "pesca"/"he fishes" a verb. It does not otherwise constrain the label.
 *
 * Model: Haiku — single-word POS tagging + lemmatization is a trivial task and this runs over whole
 * libraries; the cheapest tier holds up. Same raw-fetch, fail-soft pattern as /api/cards/verify:
 * `{ ok: false, reason }` with a 200 when the AI is unavailable or unparseable, 400 for a malformed
 * request. The client chunks (see lib/labelCards.ts) — keep LABEL_BATCH_CAP and its chunk size in step.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import type { PartOfSpeech } from '@/domain'
import type { LabelResult } from '@/lib/labelCards'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

/** Hard ceiling on cards per request. The client chunks well below this. */
export const LABEL_BATCH_CAP = 80

interface RequestBody {
  cards:          { front: string; back: string }[]
  sourceLanguage: string
  targetLanguage: string
}

const POS_VALUES: PartOfSpeech[] = [
  'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition',
  'conjunction', 'determiner', 'interjection', 'numeral', 'phrase', 'other',
]

function toPos(val: unknown): PartOfSpeech {
  return POS_VALUES.includes(val as PartOfSpeech) ? (val as PartOfSpeech) : 'other'
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function labelPrompt(cards: { front: string; back: string }[], srcLang: string, tgtLang: string): string {
  const listed = cards.map((c, i) => `${i}. ${c.front} (${c.back})`).join('\n')
  return `You are annotating ${srcLang} vocabulary flashcards for a language-learning app. For each item,
give the part of speech and dictionary lemma of the ${srcLang} text. The ${tgtLang} gloss in
parentheses is there ONLY to disambiguate between senses (e.g. between a noun and a verb reading of
the same word) — label the sense the gloss points at.

"pos" must be exactly one of:
noun, verb, adjective, adverb, pronoun, preposition, conjunction, determiner, interjection, numeral,
phrase, other

Rules:
- A multi-word item that functions as ONE lexical unit gets that unit's class: reflexive and phrasal
  verbs are "verb"; an article + noun is "noun"; a fixed compound or set expression used like a single
  word gets the head word's class.
- Anything longer that doesn't reduce to one unit — a full sentence, clause, or free phrase — is
  "phrase".
- "other" is for particles and genuinely unclassifiable items. Do not use it as a shortcut.

"lemma" is the standard dictionary citation form of the item:
- Strip any leading article; ignore annotations like (f), (m), (pl) or [notes] in the text.
- Keep a reflexive pronoun when the citation form carries it (e.g. "se précipiter").
- Lowercase unless it is a proper noun.
- For "phrase" items, set lemma to null.

Items:
${listed}

Respond with ONLY a JSON object, no other text, with exactly one entry per item:
{
  "labels": [
    { "index": 0, "pos": "noun", "lemma": "<${srcLang} citation form or null>" }
  ]
}`
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, reason: 'no-api-key' })

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const { sourceLanguage, targetLanguage } = body
  if (!sourceLanguage || !targetLanguage) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }
  const cards = Array.isArray(body.cards) ? body.cards : null
  if (!cards || cards.length === 0) {
    return NextResponse.json({ ok: false, reason: 'empty-content' }, { status: 400 })
  }
  if (cards.length > LABEL_BATCH_CAP) {
    return NextResponse.json({ ok: false, reason: 'batch-too-large' }, { status: 400 })
  }

  const prompt = labelPrompt(cards, langName(sourceLanguage), langName(targetLanguage))

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return NextResponse.json({ ok: false, reason: 'api-error' })

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const parsed = extractJson(text) as { labels?: unknown } | null
    if (!parsed || !Array.isArray(parsed.labels)) return NextResponse.json({ ok: false, reason: 'parse-error' })

    // Cards the model skipped simply stay unlabeled (null pos) — the client's next run tops them up.
    const seen = new Set<number>()
    const results: LabelResult[] = []
    for (const raw of parsed.labels) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const index = Number(r.index)
      // Drop anything that doesn't point at a real card in THIS batch — a hallucinated index would
      // otherwise label the wrong row.
      if (!Number.isInteger(index) || index < 0 || index >= cards.length) continue
      if (seen.has(index)) continue
      seen.add(index)
      const pos = toPos(r.pos)
      const lemma = typeof r.lemma === 'string' ? r.lemma.trim() : ''
      results.push({ index, pos, lemma: pos === 'phrase' || !lemma ? null : lemma })
    }

    return NextResponse.json({ ok: true, labels: results })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
