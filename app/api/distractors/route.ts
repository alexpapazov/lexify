/**
 * POST /api/distractors
 *
 * Generates AI distractor pools for a flashcard's multiple-choice mode.
 * Given a card's front/back terms (plus a sample of sibling words from the
 * same deck to avoid collisions), asks Claude for plausible-but-wrong
 * options on each side — similar in category/length/part-of-speech to the
 * correct answer, so the choice is "a bit trickier" than random words.
 *
 * Fails soft: if ANTHROPIC_API_KEY isn't configured, the request to Claude
 * fails, or the response can't be parsed, this returns `{ ok: false }` with
 * a 200 status so the client can fall back to deck-based distractors.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'
const DISTRACTORS_PER_SIDE = 6

interface RequestBody {
  front:          string
  back:           string
  sourceLanguage: string
  targetLanguage: string
  deckFronts?:    string[]
  deckBacks?:     string[]
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, reason: 'no-api-key' })
  }

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const { front, back, sourceLanguage, targetLanguage } = body
  if (!front?.trim() || !back?.trim()) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const deckFronts = (body.deckFronts ?? []).filter(Boolean).slice(0, 30)
  const deckBacks  = (body.deckBacks  ?? []).filter(Boolean).slice(0, 30)
  const avoidFront = [...new Set([...deckFronts, front])]
  const avoidBack  = [...new Set([...deckBacks, back])]

  const srcLang = sourceLanguage || 'the source language'
  const tgtLang = targetLanguage || 'the target language'

  const prompt = `You generate multiple-choice distractors for a language-learning flashcard app.

The real flashcard pair is:
- ${srcLang}: "${front}"
- ${tgtLang}: "${back}"

You need to generate TWO separate lists of wrong-answer options, one for each
side of the card, because each side is quizzed differently and needs a
different KIND of distractor.

1. "backDistractors" — used when the learner sees "${front}" (in ${srcLang})
   and must pick its meaning in ${tgtLang}. Generate ${DISTRACTORS_PER_SIDE}
   words/phrases in ${tgtLang} that are SEMANTICALLY RELATED to "${back}" —
   same general category, theme, or domain — but are clearly DIFFERENT in
   meaning, NOT synonyms, near-synonyms, or alternate valid translations of
   "${back}" (or of "${front}"). The goal is plausible-but-wrong options, never
   options that could also be considered correct.
   Example: if "${back}" means "joy", good distractors are other emotions like
   "anger", "excitement", "sadness" — NOT "happiness", since that's a synonym
   and would make the question ambiguous.
   Similar in part of speech and length to "${back}". Distinct from each other
   and from: ${avoidBack.join(', ') || '(none)'}.

2. "frontDistractors" — used when the learner sees "${back}" (in ${tgtLang})
   and must pick the matching word in ${srcLang}. Generate ${DISTRACTORS_PER_SIDE}
   words/phrases in ${srcLang} that LOOK / SOUND SIMILAR to "${front}" —
   similar spelling, letter patterns, length, or word root — so the learner
   has to recall the exact word rather than just recognizing the "shape" of
   it. These do NOT need to be related in meaning to "${front}" or "${back}"
   at all — visual/phonetic similarity is what matters.
   Example: if "${front}" is "llenar", good distractors are other similar-
   looking verbs like "llamar", "llover", "llegar".
   Distinct from each other and from: ${avoidFront.join(', ') || '(none)'}.

CRITICAL: every "frontDistractors" value must be written in ${srcLang}, and
every "backDistractors" value must be written in ${tgtLang}. Never mix
languages within a list.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "frontDistractors": ["<word in ${srcLang}>", "<word in ${srcLang}>", "<word in ${srcLang}>", "<word in ${srcLang}>", "<word in ${srcLang}>", "<word in ${srcLang}>"],
  "backDistractors": ["<word in ${tgtLang}>", "<word in ${tgtLang}>", "<word in ${tgtLang}>", "<word in ${tgtLang}>", "<word in ${tgtLang}>", "<word in ${tgtLang}>"]
}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      return NextResponse.json({ ok: false, reason: 'api-error' })
    }

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const parsed = extractJson(text) as { frontDistractors?: unknown; backDistractors?: unknown } | null

    if (!parsed) {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    const toStringList = (val: unknown): string[] => {
      if (!Array.isArray(val)) return []
      return val
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
        .filter(Boolean)
    }

    const frontDistractors = toStringList(parsed.frontDistractors)
    const backDistractors  = toStringList(parsed.backDistractors)

    if (frontDistractors.length === 0 && backDistractors.length === 0) {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    return NextResponse.json({
      ok: true,
      choices: {
        front: frontDistractors,
        back:  backDistractors,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
