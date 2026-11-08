/**
 * POST /api/media/gloss — short native glosses for a batch of lemmas (Media Intake Stage E).
 *
 * The add-as-known chips carry only a lemma (Stage D extracts no gloss for unmarked words —
 * the reader KNOWS them); the moment one is painted into a bucket it becomes a card, and a
 * card needs a back. Haiku batch-translates the painted lemmas in one call at commit time.
 *
 * Fails soft (`{ ok:false, reason }` with 200); glosses the model skips just drop out of the
 * map and the caller skips those chips rather than creating a card with an empty back.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import { parseGlosses } from '@/lib/mediaIntake'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_LEMMAS = 200

interface RequestBody {
  lemmas:         string[]
  sourceLanguage: string
  targetLanguage: string
  /** Nouns display with their definite article (the book's noun-form option). */
  nounArticle?:   boolean
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function responseText(data: unknown): string {
  const content = (data as { content?: Array<{ type?: string; text?: string }> } | null)?.content
  return content?.find(b => b?.type === 'text')?.text ?? ''
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
  if (!body.sourceLanguage || !body.targetLanguage || !Array.isArray(body.lemmas)
      || body.lemmas.length === 0 || body.lemmas.length > MAX_LEMMAS
      || body.lemmas.some(l => typeof l !== 'string')) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const srcLang = langName(body.sourceLanguage)
  const tgtLang = langName(body.targetLanguage)
  const nounForm = body.nounArticle
    ? 'nominative singular WITH its definite article (the way a learner cards gender)'
    : 'nominative singular, no article'
  const prompt = `These are ${srcLang} dictionary lemmas. For each, give:
- "gloss": a short ${tgtLang} translation (one to four words; for a verb, the infinitive form of the translation). Give ONE translation almost always; only a word with genuinely distinct meanings may have two, at most three, separated by "; ".
- "display": the flashcard form — a noun in ${nounForm}; a verb as the infinitive; an adjective masculine singular; anything else unchanged.

${body.lemmas.map((l, i) => `${i}. ${l}`).join('\n')}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{ "glosses": [ { "index": 0, "gloss": "...", "display": "..." } ] }`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      console.error('[gloss] upstream error', res.status, (await res.text()).slice(0, 300))
      return NextResponse.json({ ok: false, reason: `api-error-${res.status}` })
    }
    const data = await res.json()
    const glosses = [...parseGlosses(extractJson(responseText(data))).entries()]
      .filter(([i]) => i < body.lemmas.length)
      .map(([index, g]) => ({ index, gloss: g.gloss, display: g.display }))
    return NextResponse.json({ ok: true, glosses })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
