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
  const avoid = [...new Set([...deckFronts, ...deckBacks, front, back])]

  const srcLang = sourceLanguage || 'the source language'
  const tgtLang = targetLanguage || 'the target language'

  const prompt = `You generate multiple-choice distractors for a language-learning flashcard app.

The real flashcard pair is:
- ${srcLang}: "${front}"
- ${tgtLang}: "${back}"

Generate ${DISTRACTORS_PER_SIDE} OTHER vocabulary pairs to use as wrong-answer options. Each pair must be:
- A genuinely correct translation: "front" is a real word/phrase in ${srcLang}, and "back" is its accurate ${tgtLang} translation (NOT a translation of "${front}" / "${back}")
- Similar in category, part of speech, and length to the real pair (e.g. if the real pair is a piece of furniture, suggest other furniture)
- Clearly different from "${front}" / "${back}" — not synonyms or alternate translations of them
- Distinct from each other and from these existing words: ${avoid.join(', ') || '(none)'}

CRITICAL: every "front" value must be written in ${srcLang}, and every "back" value must be written in ${tgtLang}. Never mix languages within a field.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"pairs": [
  {"front": "<word in ${srcLang}>", "back": "<translation in ${tgtLang}>"},
  {"front": "<word in ${srcLang}>", "back": "<translation in ${tgtLang}>"},
  {"front": "<word in ${srcLang}>", "back": "<translation in ${tgtLang}>"},
  {"front": "<word in ${srcLang}>", "back": "<translation in ${tgtLang}>"},
  {"front": "<word in ${srcLang}>", "back": "<translation in ${tgtLang}>"},
  {"front": "<word in ${srcLang}>", "back": "<translation in ${tgtLang}>"}
]}`

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
    const parsed = extractJson(text) as { pairs?: unknown } | null

    if (!parsed || !Array.isArray(parsed.pairs)) {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    const toPair = (p: unknown): { front: string; back: string } | null => {
      const obj = p as { front?: unknown; back?: unknown } | null | undefined
      if (!obj || typeof obj.front !== 'string' || typeof obj.back !== 'string') return null
      const front = obj.front.trim()
      const back  = obj.back.trim()
      return front && back ? { front, back } : null
    }

    const pairs = parsed.pairs
      .map(toPair)
      .filter((p): p is { front: string; back: string } => p !== null)

    return NextResponse.json({
      ok: true,
      choices: {
        front: pairs.map(p => p.front.trim()),
        back:  pairs.map(p => p.back.trim()),
      },
    })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
