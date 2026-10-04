/**
 * POST /api/story/generate
 *
 * Story mode, generation half: weave a batch of due reverse-review words into ONE short, natural
 * story. Two passage modes (the learner picks at launch): 'target' = the whole story in the
 * learned language, with EVERY word annotated for tap-a-word glosses; 'native' = the story in the
 * learner's language with only the target words in the learned one (readable from day one).
 *
 * Model: Sonnet — deliberately the powerful tier (user decision 2026-10-04). A 40-word story is
 * long-form constrained composition: every target woven in its CARD'S sense, natural prose, plus
 * a faithful usage report; Haiku-grade output here reads as word salad and mis-anchors targets.
 *
 * Fails soft like the other AI routes: `{ ok: false, reason }` with a 200 when the AI is
 * unavailable or unparseable, 400 only for a malformed request. Wire types + parser live in
 * lib/storyReview.ts (the client must never import from app/api/** — Capacitor trap).
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import { parseStory, parseStoryTokens, STORY_BATCH_SIZE, type StoryTarget, type StoryPassageMode } from '@/lib/storyReview'

export const runtime = 'nodejs'

const MODEL = 'claude-sonnet-5'
/** Tap-a-word glosses are a separate, parallel call on the FAST tier: annotating finished text is
 *  Haiku-grade work, and folding it into the Sonnet call made the output ~5x longer — the whole
 *  reason stories took forever (generation time scales with output tokens). */
const GLOSS_MODEL = 'claude-haiku-4-5-20251001'

interface RequestBody {
  /** 'story' (default) writes the story; 'gloss' annotates an already-written story's words. */
  phase?:         'story' | 'gloss'
  targets:        StoryTarget[]
  sourceLanguage: string
  targetLanguage: string
  passage:        StoryPassageMode
  /** gloss phase only: the story text to annotate. */
  story?:         string
}

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function targetList(targets: StoryTarget[]): string {
  return targets.map(t => `- ${t.lemma} (${t.pos}, means "${t.gloss}")`).join('\n')
}

function targetPrompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  return `You are writing a short story for someone learning ${srcLang} (native language: ${tgtLang}).

TARGET WORDS — the story must use EVERY one of these, each at least once, in the exact sense
given (the quoted meaning is the sense to use, never a constraint on your plot):
${targetList(body.targets)}

Requirements:
- ONE coherent, natural story in ${srcLang} — a real narrative with characters and a thread, not a
  word-salad tour of the list. It must read like something a native speaker would actually write.
- Write the story FIRST, from the words alone; let the words suggest the setting.
- Short paragraphs (3-6 sentences each). Aim for roughly ${Math.max(100, body.targets.length * 6)} words total.
- Use each target word ITSELF — never a synonym — inflected however the sentence needs. Use each
  target's GIVEN sense, not another sense of the same word.
- Everyday, grammatical, idiomatic ${srcLang}. Simple vocabulary around the targets.

Also report "usages": for EVERY target word, its citation form copied from the list above and
the word exactly as it appears in your story (the inflected surface form).

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "title": "<a short ${srcLang} title>",
  "story": "<the full story, paragraphs separated by \\n\\n>",
  "usages": [ { "lemma": "...", "surface": "..." } ]
}`
}

function nativePrompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  return `You are writing a short story for a beginner learning ${srcLang} (native language: ${tgtLang}).

TARGET WORDS — the story must use EVERY one of these, each at least once:
${targetList(body.targets)}

Requirements:
- ONE coherent, natural story written in ${tgtLang}, EXCEPT that every target word appears in
  ${srcLang}, inflected as ${srcLang} grammar requires for its slot. Everything else — every other
  word — is ${tgtLang}.
- Write the story FIRST, from the words alone; the quoted meanings give each word's sense.
- Short paragraphs (3-6 sentences). Aim for roughly ${Math.max(120, body.targets.length * 7)} words total.
- Use each target word ITSELF — never a synonym, never its ${tgtLang} translation in the text.
- The surrounding ${tgtLang} must make each ${srcLang} word's meaning inferable from context.

Also report "usages": for EVERY target word, its citation form copied from the list above and the
word exactly as it appears in your story.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{
  "title": "<a short ${tgtLang} title>",
  "story": "<the full story, paragraphs separated by \\n\\n>",
  "usages": [ { "lemma": "...", "surface": "..." } ],
  "tokens": []
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
  if (!body.sourceLanguage || !body.targetLanguage) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0 || body.targets.length > STORY_BATCH_SIZE) {
    return NextResponse.json({ ok: false, reason: 'bad-targets' }, { status: 400 })
  }

  const srcLang = langName(body.sourceLanguage)
  const tgtLang = langName(body.targetLanguage)

  // Gloss phase: annotate a finished story's words (Haiku), fired by the client in PARALLEL with
  // reading — the story never waits on it.
  if (body.phase === 'gloss') {
    if (typeof body.story !== 'string' || !body.story.trim()) {
      return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
    }
    try {
      const glossPrompt = `Here is a short ${srcLang} story:

${body.story}

Report EVERY word of the story — content words AND grammatical words, articles and prepositions
included (skip punctuation only): "text" exactly as it appears, "gloss" a one-or-two-word
${tgtLang} meaning AS USED HERE.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{ "tokens": [ { "text": "...", "gloss": "..." } ] }`
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: GLOSS_MODEL, max_tokens: 12000, messages: [{ role: 'user', content: glossPrompt }] }),
      })
      if (!res.ok) return NextResponse.json({ ok: false, reason: 'api-error' })
      const data = await res.json()
      const tokens = parseStoryTokens(extractJson(data?.content?.[0]?.text ?? ''))
      if (tokens.length === 0) return NextResponse.json({ ok: false, reason: 'parse-error' })
      return NextResponse.json({ ok: true, tokens })
    } catch {
      return NextResponse.json({ ok: false, reason: 'exception' })
    }
  }

  const prompt = body.passage === 'native' ? nativePrompt(body, srcLang, tgtLang) : targetPrompt(body, srcLang, tgtLang)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // Prose + usages only (glosses are the separate Haiku phase), so the output stays small —
      // that is what makes the story fast; do not fold tokens back into this call.
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return NextResponse.json({ ok: false, reason: 'api-error' })

    const data = await res.json()
    const text: string = data?.content?.[0]?.text ?? ''
    const story = parseStory(extractJson(text))
    if (!story) return NextResponse.json({ ok: false, reason: 'parse-error' })

    return NextResponse.json({ ok: true, story })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
