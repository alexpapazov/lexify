/**
 * POST /api/practice/generate
 *
 * Practice Mode, generation half: given target words the learner wants to drill, produce NATURAL
 * cloze sentences — one model call, no vocabulary constraint, no repair loop.
 *
 * The per-word annotations exist for INTERACTIVITY, not policing: every word carries a native gloss
 * (click a word in the player → its meaning) and a lemma (so the player can find that word's card
 * in the learner's library). The old known-words steering — score, repair, verify, the "% graduated"
 * slider — is gone: it tripled the latency and produced stilted sentences.
 *
 * Model: Haiku — sentence-writing at this length is well inside its range, and it's the fast tier.
 * Fails soft like the other AI routes: `{ ok: false, reason }` with a 200 when the AI is
 * unavailable or unparseable, 400 only for a malformed request.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import { parseExercises, type ClozeMode } from '@/lib/practiceSchema'

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
  sourceLanguage: string
  targetLanguage: string
  count:          number
  /** 'target' (default) = a full target-language sentence. 'native' = only the blank is target. */
  mode?: ClozeMode
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

  return `You are writing short practice sentences for someone learning ${srcLang}. Their native
language is ${tgtLang}.

TARGET WORDS — each sentence must use exactly one of these, in a natural way:
${targets}

Use whatever everyday vocabulary makes the most natural sentence. There is no restriction on
which words you may use.

Write ${body.count} sentence${body.count !== 1 ? 's' : ''}. Requirements:
- Each sentence must sound like something a native speaker would ACTUALLY say or write. This
  matters more than every other requirement here.
- Each sentence is ONE natural, everyday ${srcLang} sentence of roughly 5 to 12 words.
- Concrete, ordinary situations. No riddles, no abstract word-salad, no sentences that are
  grammatical but meaningless.
- Each sentence uses exactly one target word, inflected however the sentence needs.
- Spread the sentences across the target words rather than reusing one.
- Grammatical, idiomatic ${srcLang} — correct agreement, tense and word order.
- Vary sentence structure between items; do not reuse one template.

For each sentence also report EVERY word in it — content words AND grammatical words, articles and
prepositions included, since the reader can tap any word for its meaning (skip punctuation only):
- "text": the word exactly as it appears in the sentence.
- "lemma": its dictionary citation form (infinitive for verbs, singular for nouns, no article;
  keep a reflexive pronoun where the citation form has one).
- "pos": one of noun, verb, adjective, adverb, pronoun, preposition, conjunction, determiner,
  interjection, numeral, other.
- "isFunctionWord": true for grammatical words (articles, prepositions, pronouns, conjunctions,
  auxiliaries), false for content words.
- "gloss": a one-or-two-word ${tgtLang} meaning of that word AS USED HERE.

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

/**
 * Native-mode prompt: the sentence is written in the LEARNER'S language, with only the drilled word
 * left in the language being learned.
 *
 * This is the beginner path — it needs no vocabulary at all beyond the word itself, so it works on
 * day one when there is nothing to build a real sentence from. Nothing here is scored against the
 * library, because the surrounding words are the learner's own language by construction.
 */
function nativePrompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  const targets = body.targets
    .map(t => `- ${t.lemma} (${t.pos}, means "${t.back}")`)
    .join('\n')

  return `You are writing beginner practice sentences for someone learning ${srcLang}. Their native
language is ${tgtLang}, and they know very little ${srcLang} yet.

TARGET WORDS — each sentence must use exactly one of these:
${targets}

Write ${body.count} sentence${body.count !== 1 ? 's' : ''}. Each one is a natural ${tgtLang}
sentence, EXCEPT that the target word appears in ${srcLang}, inflected as ${srcLang} grammar
requires for that slot.

Example shape (for a learner of Spanish whose language is English):
  "The ${'\u005B'}zipper${'\u005D'} se desprendió while I was running."  →  sentence: "The zipper se desprendió while I was running."

Requirements:
- The whole sentence reads as ordinary ${tgtLang} apart from the one ${srcLang} word or phrase.
- Keep it short and everyday: 5 to 12 words.
- The surrounding ${tgtLang} must make the target word's meaning clear from context.
- EXACTLY ONE ${srcLang} word per sentence: the target word. Every other word — every verb,
  particle, preposition, everything — must be ${tgtLang}. "It may rain tomorrow" must NOT become
  "It may να βρέξει tomorrow"; if the target word drags ${srcLang} grammar words along with it,
  rewrite the sentence so it doesn't.
- Inflect the ${srcLang} word correctly for how it is used (tense, number, gender, case).
- Spread the sentences across the target words rather than reusing one.
- Do NOT translate the target word into ${tgtLang} anywhere in the sentence.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "exercises": [
    {
      "targetLemma": "<the target word's citation form, copied from the list above>",
      "mode": "native",
      "sentence": "<the ${tgtLang} sentence with the ${srcLang} word inside it>",
      "answer": "<the ${srcLang} word exactly as it appears in that sentence>",
      "translation": "<the whole sentence in plain ${tgtLang}, target word translated too>",
      "tokens": []
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

  const normalized = { ...body, count }
  const prompt = body.mode === 'native'
    ? nativePrompt(normalized, langName(sourceLanguage), langName(targetLanguage))
    : generatePrompt(normalized, langName(sourceLanguage), langName(targetLanguage))

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
