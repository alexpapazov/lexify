/**
 * POST /api/media/parse-page
 *
 * Book-page intake, extraction half (Media Intake Stage 1): ONE sliding window — one or two page
 * photos — in, the marked words/phrases out, each with lemma, in-context gloss, and the COMPLETE
 * sentence it appears in (the second page exists precisely to finish sentences that run over the
 * break; extraction happens from BOTH pages — the client's collapse stage absorbs the overlap).
 *
 * Model: Sonnet VISION — reading handwriting-annotated book photographs is exactly the powerful
 * tier's job, and one window parses in seconds where the user's previous manual chat workflow
 * took 10-15 minutes. Marker descriptions are OUR prompt engineering (the user picks presets;
 * their free-text line is appended verbatim, clearly subordinate).
 *
 * Images arrive as base64 (client-downscaled) and are parsed and DISCARDED — nothing is stored.
 * Fails soft: `{ ok:false, reason }` with 200 when the AI is unavailable/unparseable, 400 only
 * for a malformed request. Wire types + parser live in lib/mediaIntake.ts (Capacitor trap).
 */

import { NextRequest, NextResponse } from 'next/server'
import { langName } from '@/lib/languages'
import { parseOccurrences, type MarkerConfig } from '@/lib/mediaIntake'

export const runtime = 'nodejs'

const MODEL = 'claude-sonnet-5'
const MAX_IMAGES = 2
/** ~2MB of base64 per image after client downscaling; reject anything wildly larger. */
const MAX_IMAGE_CHARS = 4_000_000

interface RequestBody {
  /** 1-2 data-URL or bare base64 JPEG/PNG images, reading order. */
  images:         string[]
  markers:        MarkerConfig
  sourceLanguage: string
  targetLanguage: string
}

const MARKER_FRAGMENTS: Record<keyof Omit<MarkerConfig, 'custom'>, string> = {
  circled:      'CIRCLED: a hand-drawn loop fully or partially enclosing a word or phrase, in pen or pencil, possibly sloppy or broken',
  underlined:   'UNDERLINED: a hand-drawn line under a word or phrase (single or multiple strokes; wavy counts)',
  lineToMargin: 'LINE TO MARGIN: a hand-drawn line or arrow connecting a word to the page margin or to a marginal note',
  questionMark: 'QUESTION MARK: a handwritten "?" directly above, beside, or in the margin next to a word',
  highlighted:  'HIGHLIGHTED: a translucent color band over the printed text',
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

/** "data:image/jpeg;base64,..." or bare base64 → an Anthropic image block. */
function imageBlock(image: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image)
  const mediaType = m ? m[1]! : 'image/jpeg'
  const data = m ? m[2]! : image
  if (!data || data.length > MAX_IMAGE_CHARS) return null
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

function prompt(body: RequestBody, srcLang: string, tgtLang: string): string {
  const active = (Object.keys(MARKER_FRAGMENTS) as Array<keyof typeof MARKER_FRAGMENTS>)
    .filter(k => body.markers[k])
    .map(k => `- ${MARKER_FRAGMENTS[k]}`)
  const custom = body.markers.custom.trim()
  return `These are ${body.images.length === 2 ? 'two consecutive pages' : 'one page'} of a printed ${srcLang} book, photographed by a reader who marks words they don't know.

THE READER'S MARKS — extract every word or phrase carrying any of these:
${active.join('\n')}${custom ? `\n- READER'S OWN DESCRIPTION of additional marks (follow it exactly): ${custom}` : ''}

For EVERY marked word or phrase, on either page, report:
- "text": the word/phrase exactly as printed (keep accents, casing, hyphens).
- "lemma": its ${srcLang} dictionary citation form (infinitive for verbs, singular for nouns, no
  article; for a phrase, the phrase itself).
- "kind": "word" or "phrase" (a phrase is a multi-word unit marked as one thing).
- "gloss": a short ${tgtLang} meaning AS USED in this sentence (one to four words).
- "sentence": the COMPLETE printed sentence it appears in, copied exactly. If the sentence starts
  on the first page and finishes on the second, use both pages to return the WHOLE sentence.
- "marker": which mark it carries (circled / underlined / line-to-margin / question-mark /
  highlighted / other).

Rules:
- Extract from BOTH pages when two are given.
- Only marked items — never unmarked words, never marginal notes themselves.
- Printed text only for "text" and "sentence" — ignore the reader's handwriting content.
- When unsure whether something is a mark, include it (the reader reviews everything).

Respond with ONLY a JSON object, no other text, in exactly this shape:
{ "occurrences": [ { "text": "...", "lemma": "...", "kind": "word", "gloss": "...", "sentence": "...", "marker": "underlined" } ] }`
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
  if (!body.sourceLanguage || !body.targetLanguage || typeof body.markers !== 'object' || body.markers === null) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }
  if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > MAX_IMAGES) {
    return NextResponse.json({ ok: false, reason: 'bad-images' }, { status: 400 })
  }
  const blocks = body.images.map(imageBlock)
  if (blocks.some(b => b === null)) return NextResponse.json({ ok: false, reason: 'bad-images' }, { status: 400 })

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            ...(blocks as NonNullable<ReturnType<typeof imageBlock>>[]),
            { type: 'text', text: prompt(body, langName(body.sourceLanguage), langName(body.targetLanguage)) },
          ],
        }],
      }),
    })
    if (!res.ok) {
      console.error('[intake] upstream error', res.status, (await res.text()).slice(0, 300))
      return NextResponse.json({ ok: false, reason: `api-error-${res.status}` })
    }
    const data = await res.json()
    const occurrences = parseOccurrences(extractJson(responseText(data)))
    return NextResponse.json({ ok: true, occurrences })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
