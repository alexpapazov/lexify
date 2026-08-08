/**
 * POST /api/practice/generate
 *
 * Practice Mode, generation half: given target words the learner wants to drill and a SAMPLE of
 * words they already know, produce cloze sentences with per-word annotations.
 *
 * The annotations are the whole point. This route does NOT try to satisfy "only use words from my
 * library" — asking a model to hard-satisfy a vocabulary whitelist fails, especially on inflected
 * forms. Instead it reports the lemma and word class of every word it used, and `engine/practice.ts`
 * then judges the sentence against the real library. The model proposes; code decides.
 *
 * Helper words arrive as a POS-balanced sample (see `sampleHelperWords`), not the whole library —
 * long lists cost tokens and measurably WORSEN compliance.
 *
 * Model: Haiku — the validator provides the reliability, so the cheapest tier is the right trade.
 * Fails soft like the other AI routes: `{ ok: false, reason }` with a 200 when the AI is
 * unavailable or unparseable, 400 only for a malformed request.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import { parseExercises } from '@/lib/practiceSchema'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

/** Hard ceiling on exercises per request — the client asks for far fewer. */
export const GENERATE_CAP = 12

export interface GenerateTarget {
  /** The card's front, as the learner sees it (may carry an article or a gender tag). */
  front: string
  /** Citation form — what the sentence's annotation must report for this word. */
  lemma: string
  pos:   string
  /** Native gloss, so the model picks the right sense of a homograph. */
  back:  string
}

interface RequestBody {
  targets:        GenerateTarget[]
  helperWords:    string[]
  sourceLanguage: string
  targetLanguage: string
  count:          number
  /** True when the learner's library is too narrow to build from (see `vocabularyCoverage`). */
  narrowVocabulary?: boolean
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function generatePrompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  const targets = body.targets
    .map(t => `- ${t.lemma} (${t.pos}, means "${t.back}")`)
    .join('\n')
  const helpers = body.helperWords.length > 0
    ? body.helperWords.join(', ')
    : '(none available yet)'

  // The narrow-library path: the learner genuinely can't supply enough words, so allow easy outside
  // vocabulary rather than producing nothing. `vocabularyCoverage` decided this, not the model.
  const vocabularyRule = body.narrowVocabulary
    ? `The learner's known-word list is too small to build from, so you may use other ${srcLang}
words freely — but keep them among the most common, simplest words in the language.`
    : `Build the rest of each sentence from the KNOWN WORDS list wherever you can. Where you need a
word that isn't listed, choose the most common, simplest option available.`

  return `You are writing short practice sentences for someone learning ${srcLang}. Their native
language is ${tgtLang}.

TARGET WORDS — each sentence must use exactly one of these, in a natural way:
${targets}

KNOWN WORDS — vocabulary the learner already knows well:
${helpers}

${vocabularyRule}

Write ${body.count} sentence${body.count !== 1 ? 's' : ''}. Requirements:
- Each sentence is ONE natural, everyday ${srcLang} sentence of roughly 5 to 12 words.
- Each sentence uses exactly one target word, inflected however the sentence needs.
- Spread the sentences across the target words rather than reusing one.
- Grammatical, idiomatic ${srcLang} — correct agreement, tense and word order.
- Vary sentence structure between items; do not reuse one template.

For each sentence also report every VOCABULARY WORD in it (skip punctuation):
- "text": the word exactly as it appears in the sentence.
- "lemma": its dictionary citation form (infinitive for verbs, singular for nouns, no article;
  keep a reflexive pronoun where the citation form has one).
- "pos": one of noun, verb, adjective, adverb, pronoun, preposition, conjunction, determiner,
  interjection, numeral, other.
- "isFunctionWord": true for grammatical words (articles, prepositions, pronouns, conjunctions,
  auxiliaries), false for content words.
- "gloss": a one-or-two-word ${tgtLang} meaning of that word.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "exercises": [
    {
      "targetLemma": "<the target word's citation form, copied from the list above>",
      "sentence": "<the full ${srcLang} sentence>",
      "answer": "<the target word exactly as it appears in that sentence>",
      "translation": "<the whole sentence in ${tgtLang}>",
      "tokens": [
        { "text": "...", "lemma": "...", "pos": "noun", "isFunctionWord": false, "gloss": "..." }
      ]
    }
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
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return NextResponse.json({ ok: false, reason: 'no-targets' }, { status: 400 })
  }
  const count = Number(body.count)
  if (!Number.isInteger(count) || count < 1 || count > GENERATE_CAP) {
    return NextResponse.json({ ok: false, reason: 'bad-count' }, { status: 400 })
  }

  const prompt = generatePrompt(
    { ...body, count, helperWords: body.helperWords ?? [] },
    langName(sourceLanguage), langName(targetLanguage),
  )

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // Generous: each exercise carries a sentence, a translation and one annotated object per word.
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return NextResponse.json({ ok: false, reason: 'api-error' })

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const exercises = parseExercises(extractJson(text))
    // Every exercise malformed (or none returned) is a parse failure; a partial batch is fine.
    if (exercises.length === 0) return NextResponse.json({ ok: false, reason: 'parse-error' })

    return NextResponse.json({ ok: true, exercises })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
