/**
 * POST /api/practice/verify
 *
 * The quality gate between generation and the learner. Judges each candidate sentence for whether
 * it is actually GOOD ${srcLang} — grammatical, idiomatic, and meaningful — and whether its
 * translation matches.
 *
 * Why this exists as a separate pass, and on a stronger model: generation runs on Haiku, which is
 * fine for major languages but produces noticeably shakier sentences in lower-resource ones
 * (Bulgarian was the reported case). A model can't reliably catch its own generation errors, so the
 * judge has to be better than the writer. Judging is also the cheap half — short inputs, a one-word
 * verdict per sentence — so the upgrade costs far less here than moving generation itself.
 *
 * The cost is one-time: only sentences that pass are shown AND banked
 * (`lib/data/practiceSentences.ts`), so a sentence is judged once and reused for free thereafter.
 *
 * Fails soft like the other AI routes: `{ ok: false, reason }` with a 200. Callers treat a failed
 * verification as "couldn't check" and fall back to showing the sentences — an unavailable judge
 * shouldn't empty the session.
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'

export const runtime = 'nodejs'

/**
 * Deliberately NOT the generator's Haiku. See the file header: the judge must outclass the writer,
 * and this is the cheaper half of the work.
 */
const MODEL = 'claude-sonnet-5'

/** Hard ceiling per request. The client batches well below this. */
export const VERIFY_SENTENCE_CAP = 20

export interface SentenceVerdict {
  /** Index into the request's `sentences` array. */
  index: number
  ok:    boolean
  /** Short reason when `ok` is false — for logs, not for the learner. */
  issue?: string
}

interface RequestBody {
  sentences:      { sentence: string; translation: string; targetWord: string }[]
  sourceLanguage: string
  targetLanguage: string
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function verifyPrompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  const listed = body.sentences
    .map((s, i) => `${i}. ${s.sentence}\n   drills: ${s.targetWord}\n   ${tgtLang}: ${s.translation}`)
    .join('\n')

  return `You are a strict native-speaker proof-reader for ${srcLang}. These sentences were written
by a smaller model for a language learner, and some of them are poor. Your job is to reject the bad
ones before the learner sees them.

REJECT a sentence if any of these is true:
- It is ungrammatical, or a native speaker would not say it that way.
- The word order, case, aspect, agreement, or verb form is wrong.
- It is semantically odd, contradictory, or nonsense — technically parseable but meaningless.
- The word it is supposed to drill is used incorrectly, or in a sense that doesn't fit.
- The ${tgtLang} translation does not match what the ${srcLang} sentence actually says.
- It is a word salad, a fragment, or a machine-translation artefact.

ACCEPT a sentence if it is something a literate native speaker could plausibly write, even if it is
simple, plain, or a little dull. Simplicity is not a defect — these are practice sentences for a
learner, so short and ordinary is GOOD.

Be strict about correctness and lenient about style.

Sentences:
${listed}

Respond with ONLY a JSON object, no other text, with exactly one entry per sentence:
{
  "verdicts": [
    { "index": 0, "ok": true },
    { "index": 1, "ok": false, "issue": "<a few words on what is wrong>" }
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
  const sentences = Array.isArray(body.sentences) ? body.sentences : null
  if (!sentences || sentences.length === 0) {
    return NextResponse.json({ ok: false, reason: 'empty-content' }, { status: 400 })
  }
  if (sentences.length > VERIFY_SENTENCE_CAP) {
    return NextResponse.json({ ok: false, reason: 'batch-too-large' }, { status: 400 })
  }

  const prompt = verifyPrompt(
    { ...body, sentences }, langName(sourceLanguage), langName(targetLanguage),
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
    const parsed = extractJson(text) as { verdicts?: unknown } | null
    if (!parsed || !Array.isArray(parsed.verdicts)) {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    const seen = new Set<number>()
    const verdicts: SentenceVerdict[] = []
    for (const raw of parsed.verdicts) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const index = Number(r.index)
      if (!Number.isInteger(index) || index < 0 || index >= sentences.length) continue
      if (seen.has(index)) continue
      seen.add(index)
      verdicts.push({
        // Only an explicit `false` rejects. A malformed verdict shouldn't silently bin a sentence
        // that might be fine — the caller treats unjudged sentences as passing.
        index,
        ok: r.ok !== false,
        ...(typeof r.issue === 'string' && r.issue.trim() ? { issue: r.issue.trim() } : {}),
      })
    }

    return NextResponse.json({ ok: true, verdicts })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
