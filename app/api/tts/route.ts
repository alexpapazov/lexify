/**
 * POST /api/tts
 *
 * Generates speech audio for a single word/phrase.
 * Prefers ElevenLabs eleven_turbo_v2_5 (which ENFORCES an explicit language_code —
 * multilingual_v2 only auto-detects and mis-reads short Cyrillic words as Russian)
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

/**
 * Strips annotations that shouldn't be spoken — gender/number markers like "(f)",
 * "(m)", "(pl)", bracketed notes, and surrounding whitespace. Sending these to TTS
 * makes it try to vocalise the "(f)", garbling short words into nonsense. Falls back
 * to the original text if cleaning would empty it out.
 */
function cleanForSpeech(text: string): string {
  const cleaned = text
    .replace(/\([^)]*\)/g, ' ')   // (f), (m), (pl), inline notes
    .replace(/\[[^\]]*\]/g, ' ')  // [notes]
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || text.trim()
}

async function ttsElevenLabs(text: string, language: string, apiKey: string): Promise<string> {
  // A trailing period gives the model a phrase boundary — short isolated words
  // otherwise get their onset clipped or come out as garbled nonsense.
  const padded = /[.!?…。]$/.test(text) ? text : `${text}.`
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
        text: padded,
        // Turbo v2.5 honours language_code (multilingual_v2 ignores it and guesses).
        model_id:      'eleven_turbo_v2_5',
        language_code: language,
        // Higher stability = steadier, less-hallucinated output on very short inputs.
        voice_settings: { stability: 0.6, similarity_boost: 0.8, use_speaker_boost: true },
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
    const speakText = cleanForSpeech(text)
    const audioData = elevenKey
      ? await ttsElevenLabs(speakText, language, elevenKey)
      : await ttsOpenAI(speakText, openaiKey!)
    return NextResponse.json({ ok: true, audioData })
  } catch (err) {
    console.error('[TTS] error', err)
    return NextResponse.json({ ok: false, reason: 'api-error' })
  }
}
