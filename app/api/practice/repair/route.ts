/**
 * POST /api/practice/repair
 *
 * Practice Mode, repair half: a generated sentence used a word the learner doesn't know. Rewrite it
 * so that word is replaced by one the learner DOES know, keeping the target word and the meaning.
 *
 * Why the whole sentence comes back rather than just a replacement word: swapping a word usually
 * drags agreement, tense or word order with it ("une grande maison" → "un grand jardin"). Letting
 * the model rewrite and re-annotate keeps the sentence grammatical; the result is re-scored by
 * `engine/practice.ts` anyway, which is cheap and pure, so a bad repair is caught rather than
 * trusted.
 *
 * One attempt per offending word — see `lib/practiceGenerate.ts`. If the rewrite still doesn't
 * clear, the original word is kept and shown flagged with its translation, which is the documented
 * fallback in `features/Practice Mode.md`.
 *
 * Fails soft like the other AI routes: `{ ok: false, reason }` with a 200, 400 only for a malformed
 * request.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import { parseExercise } from '@/lib/practiceSchema'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

interface RequestBody {
  /** The sentence to rewrite. */
  sentence:       string
  /** Surface form of the word that must go. */
  offendingWord:  string
  /** Word class of the offender, so the replacement fits the same slot. */
  offendingPos:   string
  /** Known words of that class to choose from. */
  candidates:     string[]
  /** The drilled word — must survive the rewrite untouched in meaning. */
  targetLemma:    string
  /** Surface form of the target word; the rewritten sentence must still contain a form of it. */
  targetSurface:  string
  sourceLanguage: string
  targetLanguage: string
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function repairPrompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  return `You are revising a ${srcLang} practice sentence for a learner whose native language is
${tgtLang}.

SENTENCE: ${body.sentence}

The word "${body.offendingWord}" (${body.offendingPos}) is not one the learner knows. Rewrite the
sentence so that word is gone, replaced by one of these words they DO know:
${body.candidates.length > 0 ? body.candidates.join(', ') : '(no suggestions — use the simplest common word that fits)'}

Rules:
- Keep the word "${body.targetLemma}" in the sentence (any inflected form is fine) — it is what the
  learner is practising.
- Change as little else as possible, but DO fix agreement, gender, tense and word order so the
  result is natural, grammatical ${srcLang}.
- Keep every other word the same where you can.
- The meaning may shift with the replaced word; that is expected.

Report every VOCABULARY WORD of the rewritten sentence (skip punctuation), exactly as before:
"text" (as it appears), "lemma" (dictionary citation form), "pos" (noun, verb, adjective, adverb,
pronoun, preposition, conjunction, determiner, interjection, numeral, other), "isFunctionWord"
(true for grammatical words), "gloss" (a one-or-two-word ${tgtLang} meaning).

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "targetLemma": "${body.targetLemma}",
  "sentence": "<the rewritten ${srcLang} sentence>",
  "answer": "<the target word exactly as it appears in the rewritten sentence>",
  "translation": "<the rewritten sentence in ${tgtLang}>",
  "tokens": [
    { "text": "...", "lemma": "...", "pos": "noun", "isFunctionWord": false, "gloss": "..." }
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

  if (!body.sentence || !body.offendingWord || !body.sourceLanguage || !body.targetLanguage) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const prompt = repairPrompt(
    { ...body, candidates: body.candidates ?? [] },
    langName(body.sourceLanguage), langName(body.targetLanguage),
  )

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return NextResponse.json({ ok: false, reason: 'api-error' })

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const exercise = parseExercise(extractJson(text))
    if (!exercise) return NextResponse.json({ ok: false, reason: 'parse-error' })

    return NextResponse.json({ ok: true, exercise })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
