/**
 * POST /api/sync-translate
 *
 * Translates a source-language word/phrase into a destination language pair
 * for the Language Syncing feature.
 *
 * The spec requires: translate source front → dest learned language (front)
 * and → dest basis language (back).  The semantic anchor is always the source
 * front (the word being learned in the source pair).
 *
 * Returns { ok: true, front, back, confidence, warning? }
 * or      { ok: false, reason }
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

interface RequestBody {
  sourceFront:       string   // e.g. "maison" (French word being learned)
  sourceBack:        string   // e.g. "house"  (its basis-language gloss)
  fromLanguage:      string   // source-pair learned language code, e.g. "fr"
  toLearnedLanguage: string   // dest-pair learned language code,  e.g. "ko"
  toBasisLanguage:   string   // dest-pair basis language code,    e.g. "en"
  instructions?:     string   // optional per-pair formatting instructions
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
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

  const { sourceFront, sourceBack, fromLanguage, toLearnedLanguage, toBasisLanguage, instructions } = body
  if (!sourceFront?.trim()) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const fromName      = langName(fromLanguage)
  const toLearnedName = langName(toLearnedLanguage)
  const toBasisName   = langName(toBasisLanguage)

  const prompt = `You are a translation assistant for a language learning app.

A flashcard in ${fromName} reads:
  Front (word being learned): "${sourceFront}"
  Back (basis-language gloss): "${sourceBack}"

Translate this into a new language pair:
  New front: the equivalent word/phrase in ${toLearnedName} (the language being learned in the destination pair)
  New back:  the equivalent word/phrase in ${toBasisName}  (the basis/native language in the destination pair)

IMPORTANT: derive the translation from the SOURCE FRONT ("${sourceFront}"), not from the back gloss.
${instructions?.trim() ? `\nFormatting instructions — follow these when choosing word forms (e.g. infinitive for verbs, masculine nominative singular for nouns):\n${instructions.trim()}\n` : ''}
Return ONLY a JSON object, no other text:
{
  "front": "translated word/phrase in ${toLearnedName}",
  "back": "translated word/phrase in ${toBasisName}",
  "confidence": 0.0-1.0,
  "warning": "optional note if translation is uncertain, has multiple valid forms, or regional caveats — or null if none"
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
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) return NextResponse.json({ ok: false, reason: 'api-error' })

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const parsed = extractJson(text) as {
      front?:      unknown
      back?:       unknown
      confidence?: unknown
      warning?:    unknown
    } | null

    if (!parsed || typeof parsed.front !== 'string' || typeof parsed.back !== 'string') {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    return NextResponse.json({
      ok:         true,
      front:      parsed.front.trim(),
      back:       parsed.back.trim(),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      warning:    typeof parsed.warning === 'string' && parsed.warning ? parsed.warning : null,
    })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
