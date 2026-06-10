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

  const prompt = `You generate multiple-choice distractors for a language-learning flashcard app.

Card:
- Term in ${sourceLanguage || 'the source language'} (front): "${front}"
- Translation in ${targetLanguage || 'the target language'} (back): "${back}"

For EACH side, generate ${DISTRACTORS_PER_SIDE} plausible-but-INCORRECT options a learner might mistakenly pick. They should be:
- The same language as that side (front options in ${sourceLanguage || 'the source language'}, back options in ${targetLanguage || 'the target language'})
- Similar in category, part of speech, and length to the correct answer (e.g. if the answer is a piece of furniture, suggest other furniture)
- Plausible but clearly different words — not synonyms or alternate translations of the correct answer
- Distinct from each other and from these existing words: ${avoid.join(', ') || '(none)'}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"front": ["option1", "option2", "option3", "option4", "option5", "option6"], "back": ["option1", "option2", "option3", "option4", "option5", "option6"]}`

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
    const parsed = extractJson(text) as { front?: unknown; back?: unknown } | null

    if (!parsed || !Array.isArray(parsed.front) || !Array.isArray(parsed.back)) {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    const clean = (arr: unknown[]) =>
      arr.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())

    return NextResponse.json({
      ok: true,
      choices: { front: clean(parsed.front), back: clean(parsed.back) },
    })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
