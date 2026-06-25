/**
 * POST /api/ipa
 *
 * Generates IPA (International Phonetic Alphabet) transcription for a
 * card's front (source-language) text using Claude Haiku. Returns the IPA
 * string; the client caches and persists it via the card repository.
 *
 * Fails soft: returns { ok: false } on error so the session continues
 * gracefully without IPA.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const MODEL = 'claude-haiku-4-5-20251001'

interface RequestBody {
  text:     string
  language: string
}

export async function POST(req: NextRequest) {
  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const { text, language } = body
  if (!text?.trim() || !language) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, reason: 'no-api-key' })
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Provide the IPA transcription for this ${language} word or phrase: "${text.trim()}"\n\nReturn ONLY the IPA transcription between forward slashes, nothing else. Example: /example/`,
        }],
      }),
    })

    if (!res.ok) {
      console.error('[IPA] Claude API error', res.status)
      return NextResponse.json({ ok: false, reason: 'api-error' })
    }

    const data = await res.json()
    const raw: string = data?.content?.[0]?.text?.trim() ?? ''

    // Extract content from /.../ or [...] notation.
    const match = /[/\[]([^/\]]+)[/\]]/.exec(raw)
    const ipa = match ? match[1]!.trim() : raw.replace(/^\/|\/$/g, '').trim()

    if (!ipa) {
      return NextResponse.json({ ok: false, reason: 'parse-error' })
    }

    return NextResponse.json({ ok: true, ipa })
  } catch (err) {
    console.error('[IPA] error', err)
    return NextResponse.json({ ok: false, reason: 'api-error' })
  }
}
