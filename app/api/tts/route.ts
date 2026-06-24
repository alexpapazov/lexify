/**
 * POST /api/tts
 *
 * Generates speech audio for a single word/phrase using OpenAI TTS (tts-1).
 * Returns base64-encoded mp3. Only called for source-language (learned language)
 * text — never for the learner's native language.
 *
 * Fails soft: returns { ok: false } on any error so callers fall back to
 * browser TTS gracefully.
 */

import { NextRequest, NextResponse } from 'next/server'
import { TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'

export const runtime = 'nodejs'

interface RequestBody {
  text:     string
  language: string
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, reason: 'no-api-key' })
  }

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  const { text, language } = body
  if (!text?.trim()) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  if (!TTS_SUPPORTED_LANGUAGES.has(language)) {
    return NextResponse.json({ ok: false, reason: 'unsupported-language' })
  }

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:           'tts-1',
        input:           text.trim(),
        voice:           'nova',
        response_format: 'mp3',
      }),
    })

    if (!res.ok) {
      return NextResponse.json({ ok: false, reason: 'api-error' })
    }

    const buffer   = await res.arrayBuffer()
    const audioData = Buffer.from(buffer).toString('base64')

    return NextResponse.json({ ok: true, audioData })
  } catch {
    return NextResponse.json({ ok: false, reason: 'exception' })
  }
}
