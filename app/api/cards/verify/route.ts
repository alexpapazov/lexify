/**
 * POST /api/cards/verify
 *
 * Vocabulary-onboarding step 1: check that a batch of { front, back } pairs are actually correct
 * before the learner rates their confidence on them. Onboarding takes a rating at face value and
 * schedules the card months out, so a wrong gloss would sit undetected for a long time — this is the
 * gate that stops that.
 *
 * DISTINCT from the `languageWarning` produced by /api/cards/generate, which only asks "is this text
 * in the right language". This route judges the translation itself: mistranslations, glosses so
 * ambiguous the learner couldn't know which sense is meant, and swapped/wrong-language sides.
 *
 * The client sends batches (see lib/onboardVerify.ts) — a whole frequency list in one request would
 * blow the response token budget. Keep VERIFY_BATCH_CAP and the client's chunk size in step.
 *
 * Fails soft the same way /api/cards/generate does: `{ ok: false, reason }` with a 200 when the AI
 * is unavailable or unparseable, 400 only for a malformed request.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

/** Hard ceiling on cards per request. The client chunks well below this. */
export const VERIFY_BATCH_CAP = 60

/**
 * What's wrong with a flagged card:
 *   'mistranslation' — the back isn't what the front means
 *   'ambiguous'      — the gloss spans several senses, so the card can't be graded fairly
 *   'language'       — a side is in the wrong language (often the two are simply swapped)
 */
export type VerifyIssue = 'mistranslation' | 'ambiguous' | 'language'

export interface VerifyResult {
  /** Index into the request's `cards` array. */
  index:          number
  issue:          VerifyIssue
  /** One short sentence the learner can act on. */
  note:           string
  /** Corrected text, when the model can offer one. Absent = "you decide". */
  suggestedFront?: string
  suggestedBack?:  string
}

interface RequestBody {
  cards:          { front: string; back: string }[]
  sourceLanguage: string
  targetLanguage: string
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function toIssue(val: unknown): VerifyIssue | null {
  return val === 'mistranslation' || val === 'ambiguous' || val === 'language' ? val : null
}

function verifyPrompt(cards: { front: string; back: string }[], srcLang: string, tgtLang: string): string {
  const listed = cards.map((c, i) => `${i}. ${c.front} => ${c.back}`).join('\n')
  return `You are proof-reading vocabulary flashcards before a learner commits them to long-term study.
Each card has a front in ${srcLang} and a back in ${tgtLang}.

Report ONLY cards that are genuinely wrong. Flag a card when:
- "mistranslation": the back is not a correct meaning of the front.
- "ambiguous": the back is so broad or multi-sense that the learner could not know which meaning to
  produce (e.g. a single English word glossing several unrelated ${srcLang} words).
- "language": a side is written in the wrong language, including the two sides being swapped.

Do NOT flag:
- A correct translation you would have worded differently.
- A missing or present article, gender marker like (f)/(m)/(pl), or capitalisation difference.
- A regional or informal but valid synonym.
- A reasonable narrowing of a broad word.

When you can, give a corrected "suggestedFront" and/or "suggestedBack". Omit them if the card needs a
human decision. Keep every "note" to one short sentence.

Cards:
${listed}

Respond with ONLY a JSON object, no other text, in exactly this shape — an EMPTY array if every card
is fine:
{
  "flagged": [
    { "index": 0, "issue": "mistranslation", "note": "<one sentence>", "suggestedFront": "<${srcLang} text>", "suggestedBack": "<${tgtLang} text>" }
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
  if (cards.length > VERIFY_BATCH_CAP) {
    return NextResponse.json({ ok: false, reason: 'batch-too-large' }, { status: 400 })
  }

  const prompt = verifyPrompt(cards, langName(sourceLanguage), langName(targetLanguage))

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
    const parsed = extractJson(text) as { flagged?: unknown } | null
    // A well-formed "nothing wrong" answer is an empty array, so only a MISSING array is a parse
    // failure. Treating [] as a failure would flag a clean batch as unverifiable.
    if (!parsed || !Array.isArray(parsed.flagged)) return NextResponse.json({ ok: false, reason: 'parse-error' })

    const seen = new Set<number>()
    const results: VerifyResult[] = []
    for (const raw of parsed.flagged) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const index = Number(r.index)
      const issue = toIssue(r.issue)
      // Drop anything that doesn't point at a real card in THIS batch — a hallucinated index would
      // otherwise flag (or silently mis-flag) the wrong row.
      if (!Number.isInteger(index) || index < 0 || index >= cards.length || !issue) continue
      if (seen.has(index)) continue
      seen.add(index)
      const suggestedFront = typeof r.suggestedFront === 'string' ? r.suggestedFront.trim() : ''
      const suggestedBack  = typeof r.suggestedBack  === 'string' ? r.suggestedBack.trim()  : ''
      results.push({
        index,
        issue,
        note: typeof r.note === 'string' ? r.note.trim() : '',
        // Only surface a suggestion that actually differs — "fix it to what it already says" is noise.
        ...(suggestedFront && suggestedFront !== cards[index]!.front ? { suggestedFront } : {}),
        ...(suggestedBack  && suggestedBack  !== cards[index]!.back  ? { suggestedBack  } : {}),
      })
    }

    return NextResponse.json({ ok: true, flagged: results })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
