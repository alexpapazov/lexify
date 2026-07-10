/**
 * POST /api/tts
 *
 * Generates speech audio for a single word/phrase.
 * Prefers ElevenLabs eleven_multilingual_v2 (native-accented for all languages)
 * when ELEVENLABS_API_KEY is set; falls back to OpenAI tts-1-hd otherwise.
 * Returns base64-encoded mp3. Only called for source-language (learned language)
 * text — never for the learner's native language.
 *
 * Fails soft: returns { ok: false } on any error so callers fall back to
 * browser TTS gracefully.
 */

import { NextRequest, NextResponse } from 'next/server'
import { TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'

export const runtime = 'nodejs'

// ElevenLabs voice — uses the ELEVENLABS_VOICE_ID env var when set, else falls
// back to "Rachel", which works well across all supported languages with the
// eleven_multilingual_v2 model (it adapts accent to match the input language).
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'

interface RequestBody {
  text:     string
  language: string
}

async function ttsElevenLabs(text: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`ElevenLabs ${res.status}: ${errText}`)
  }
  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

async function ttsOpenAI(text: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:           'tts-1-hd',
      input:           text,
      voice:           'nova',
      response_format: 'mp3',
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`OpenAI ${res.status}: ${errText}`)
  }
  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

export async function POST(req: NextRequest) {
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

  const elevenKey = process.env.ELEVENLABS_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  if (!elevenKey && !openaiKey) {
    return NextResponse.json({ ok: false, reason: 'no-api-key' })
  }

  try {
    const audioData = elevenKey
      ? await ttsElevenLabs(text.trim(), elevenKey)
      : await ttsOpenAI(text.trim(), openaiKey!)
    return NextResponse.json({ ok: true, audioData })
  } catch (err) {
    console.error('[TTS] error', err)
    return NextResponse.json({ ok: false, reason: 'api-error' })
  }
}
