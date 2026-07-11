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

// mp3_44100_128 is constant-bitrate 128 kbps, so audio duration ≈ bytes·8 / 128000.
const ELEVEN_BITRATE = 128_000
// Per-attempt stability so retries actually differ (a fixed request can repeat a clip).
const ELEVEN_ATTEMPTS = [0.6, 0.45, 0.8]

async function ttsElevenLabsOnce(
  paddedText: string, language: string, apiKey: string, stability: number, seed: number,
): Promise<{ base64: string; durationSec: number }> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text: paddedText,
        // Turbo v2.5 honours language_code (multilingual_v2 ignores it and guesses).
        model_id:      'eleven_turbo_v2_5',
        language_code: language,
        seed,
        voice_settings: { stability, similarity_boost: 0.8, use_speaker_boost: true },
      }),
    }
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`ElevenLabs ${res.status}: ${errText}`)
  }
  const buffer = await res.arrayBuffer()
  return { base64: Buffer.from(buffer).toString('base64'), durationSec: (buffer.byteLength * 8) / ELEVEN_BITRATE }
}

/**
 * Generates speech, guarding against ElevenLabs' habit of clipping short isolated
 * words (rendering only the start or only the end). Generation is non-deterministic,
 * so we try a few times (varying stability/seed) and keep the first clip whose
 * duration is plausible for the text length — or, failing that, the longest one
 * (the complete rendering is longer than any clipped half).
 */
async function ttsElevenLabs(text: string, language: string, apiKey: string): Promise<string> {
  // A trailing period gives the model a phrase boundary; a leading pause inflates the
  // duration signal, so we only pad the end and lean on the duration guard for onset clips.
  const padded = /[.!?…。]$/.test(text) ? text : `${text}.`
  // Expected minimum seconds for a complete rendering (~50 ms per non-space character).
  const minSec = Math.max(0.35, text.replace(/\s+/g, '').length * 0.05)

  let best: { base64: string; durationSec: number } | null = null
  for (let i = 0; i < ELEVEN_ATTEMPTS.length; i++) {
    const out = await ttsElevenLabsOnce(padded, language, apiKey, ELEVEN_ATTEMPTS[i]!, i + 1)
    if (out.durationSec >= minSec) return out.base64         // plausible length → accept
    if (!best || out.durationSec > best.durationSec) best = out
  }
  // Every attempt came back short (likely clipped) — return the longest we got.
  return best!.base64
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
