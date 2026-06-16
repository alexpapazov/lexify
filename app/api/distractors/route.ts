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
const SYNONYMS_PER_SIDE = 4

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

You need to generate FOUR separate lists:

━━━ DISTRACTORS (wrong-answer options) ━━━

1. "backDistractors" — used when the learner sees "${front}" (in ${srcLang})
   and must pick its meaning in ${tgtLang}. Generate ${DISTRACTORS_PER_SIDE}
   words/phrases in ${tgtLang} that are from the SAME SEMANTIC CATEGORY as
   "${back}" but have CLEARLY DIFFERENT DENOTATIONS — not synonyms, not
   near-synonyms, not alternate translations. The learner must be genuinely
   wrong to pick one.
   CRITICAL: if "${back}" means "puppy", then "pup" and "puppy dog" are
   INVALID (synonyms). Valid distractors are "kitten", "bunny", "duckling" —
   different animals in the same category.
   Example: if "${back}" is "joy", valid distractors are "anger", "sadness",
   "fear" — NOT "happiness", "delight", or "elation" (all synonyms of joy).
   Similar in part of speech and grammatical form to "${back}". Distinct from
   each other and from: ${avoidBack.join(', ') || '(none)'}.

2. "frontDistractors" — used when the learner sees "${back}" (in ${tgtLang})
   and must pick the matching word in ${srcLang}. Generate ${DISTRACTORS_PER_SIDE}
   words/phrases in ${srcLang} that LOOK / SOUND SIMILAR to "${front}" —
   similar spelling, letter patterns, length, or word root — so the learner
   has to recall the exact word rather than just recognizing the "shape" of
   it. These do NOT need to be related in meaning to "${front}" at all.
   Example: if "${front}" is "llenar", valid distractors are "llamar",
   "llover", "llegar". Distinct from each other and from: ${avoidFront.join(', ') || '(none)'}.

━━━ SYNONYMS (alternate correct answers to ACCEPT, NOT show as distractors) ━━━

3. "backSynonyms" — up to ${SYNONYMS_PER_SIDE} words/phrases in ${tgtLang}
   that are genuine synonyms, near-synonyms, or equally valid translations of
   "${back}". These will be accepted as correct if the learner types or picks
   them. If "${back}" has no common synonyms, return an empty list [].
   Example: if "${back}" is "puppy", return ["pup", "puppy dog"].
   Example: if "${back}" is "joy", return ["happiness", "delight"].

4. "frontSynonyms" — up to ${SYNONYMS_PER_SIDE} words/phrases in ${srcLang}
   that are genuine synonyms or equally valid forms of "${front}". If none
   exist, return []. Example: if "${front}" is "el auto", return ["el coche",
   "el carro"].

━━━ FORMATTING RULE ━━━

If "${back}" or "${front}" uses a slash ("traffic jam / jam") or parenthetical
("estate (property)"), every distractor on that side must follow the SAME
pattern so the format isn't a giveaway. If the correct answer has no such
punctuation, distractors should also be plain.

CRITICAL LANGUAGE CHECK: "frontDistractors" and "frontSynonyms" must be in
${srcLang}. "backDistractors" and "backSynonyms" must be in ${tgtLang}.

Respond with ONLY a JSON object, no other text:
{
  "frontDistractors": ["...", "...", "...", "...", "...", "..."],
  "backDistractors":  ["...", "...", "...", "...", "...", "..."],
  "frontSynonyms":    ["...", "..."],
  "backSynonyms":     ["...", "..."]
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
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      return NextResponse.json({ ok: false, reason: 'api-error' })
    }

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const parsed = extractJson(text) as {
      frontDistractors?: unknown
      backDistractors?:  unknown
      frontSynonyms?:    unknown
      backSynonyms?:     unknown
    } | null

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

    const frontSynonyms = toStringList(parsed.frontSynonyms)
    const backSynonyms  = toStringList(parsed.backSynonyms)

    return NextResponse.json({
      ok: true,
      choices: {
        front: frontDistractors,
        back:  backDistractors,
        ...(frontSynonyms.length > 0 && { frontSynonyms }),
        ...(backSynonyms.length  > 0 && { backSynonyms }),
      },
    })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
