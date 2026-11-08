/**
 * POST /api/media/order-pages — the ORDERING pass of book-page intake (2026-11-07).
 *
 * Uploading photos in reading order is fiddly, so the user doesn't have to: this route reads
 * the PRINTED page number off each photo (Haiku vision — page numbers are short and cheap),
 * the client sorts by them, and extraction then runs on genuinely consecutive pairs. A photo
 * with no readable number comes back null and keeps its upload position.
 *
 * Images are parsed and discarded, like parse-page. Fails soft (`{ ok:false, reason }`).
 */

import { NextRequest, NextResponse } from 'next/server'
import { parsePageNumbers } from '@/lib/mediaIntake'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_IMAGES = 8
const MAX_IMAGE_CHARS = 4_000_000

function extractJson(text: string): unknown {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function responseText(data: unknown): string {
  const content = (data as { content?: Array<{ type?: string; text?: string }> } | null)?.content
  return content?.find(b => b?.type === 'text')?.text ?? ''
}

function imageBlock(image: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image)
  const mediaType = m ? m[1]! : 'image/jpeg'
  const data = m ? m[2]! : image
  if (!data || data.length > MAX_IMAGE_CHARS) return null
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

const PROMPT = (count: number) => `These are ${count} photographs of printed book pages, in no particular order.

For EACH image (index 0 to ${count - 1}, in the order given), find the PRINTED page number — usually
at the top or bottom margin of the page. If a photo shows two facing pages, report the LEFT (lower)
page's number. If no page number is legible anywhere, use null.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{ "pages": [ { "index": 0, "pageNumber": 42 }, { "index": 1, "pageNumber": null } ] }`

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, reason: 'no-api-key' })

  let body: { images: string[] }
  try {
    body = await req.json()
  } catch {
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
        model: MODEL, max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            ...(blocks as NonNullable<ReturnType<typeof imageBlock>>[]),
            { type: 'text', text: PROMPT(body.images.length) },
          ],
        }],
      }),
    })
    if (!res.ok) {
      console.error('[order-pages] upstream error', res.status, (await res.text()).slice(0, 300))
      return NextResponse.json({ ok: false, reason: `api-error-${res.status}` })
    }
    const data = await res.json()
    const parsed = parsePageNumbers(extractJson(responseText(data)))
    const pages = [...parsed.entries()]
      .filter(([i]) => i < body.images.length)
      .map(([index, pageNumber]) => ({ index, pageNumber }))
    return NextResponse.json({ ok: true, pages })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
