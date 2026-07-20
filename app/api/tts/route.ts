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
  /** Which provider to fetch from. Defaults to 'elevenlabs' (falls back to OpenAI). */
  source?:  'elevenlabs' | 'forvo' | 'standard'
  /** When source is 'forvo', fall through to ElevenLabs on any Forvo miss instead of failing. */
  fallback?: boolean
}

// ─── Google Cloud TTS, "Standard" tier ───────────────────────────────────────
// Classic concatenative TTS — explicitly NOT Google's Neural2/Studio (generative) voices. Clearly
// synthetic, but far cleaner than a device compact voice, and crucially it is ONE fixed voice per
// language: every user hears the identical clip, unlike Forvo's crowd-sourced recordings. The result
// is stored on the card like any other source, so it's generated once and then served offline.
const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize'

/** Locale + fixed Standard voice per language. Pinned by name so the voice never drifts between cards. */
const GOOGLE_STANDARD_VOICE: Record<string, { code: string; name: string }> = {
  es: { code: 'es-ES', name: 'es-ES-Standard-A' },
  en: { code: 'en-US', name: 'en-US-Standard-C' },
  fr: { code: 'fr-FR', name: 'fr-FR-Standard-A' },
  it: { code: 'it-IT', name: 'it-IT-Standard-A' },
  ko: { code: 'ko-KR', name: 'ko-KR-Standard-A' },
  bg: { code: 'bg-BG', name: 'bg-bg-Standard-A' },
  el: { code: 'el-GR', name: 'el-GR-Standard-A' },
  de: { code: 'de-DE', name: 'de-DE-Standard-A' },
  pt: { code: 'pt-PT', name: 'pt-PT-Standard-A' },
  ru: { code: 'ru-RU', name: 'ru-RU-Standard-A' },
  ja: { code: 'ja-JP', name: 'ja-JP-Standard-A' },
  zh: { code: 'cmn-CN', name: 'cmn-CN-Standard-A' },
  nl: { code: 'nl-NL', name: 'nl-NL-Standard-A' },
  pl: { code: 'pl-PL', name: 'pl-PL-Standard-A' },
  tr: { code: 'tr-TR', name: 'tr-TR-Standard-A' },
  uk: { code: 'uk-UA', name: 'uk-UA-Standard-A' },
}

/** Synthesises `text` with the pinned Standard voice for `language`; returns base64 mp3. */
async function ttsGoogleStandard(text: string, language: string, apiKey: string): Promise<string> {
  const v = GOOGLE_STANDARD_VOICE[language.slice(0, 2).toLowerCase()]
  if (!v) throw new Error('standard-unsupported-language')
  const res = await fetch(`${GOOGLE_TTS_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: v.code, name: v.name },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  })
  if (!res.ok) throw new Error(`Google TTS ${res.status}: ${await res.text().catch(() => '')}`)
  const data = await res.json().catch(() => null)
  const b64 = data?.audioContent as string | undefined
  if (!b64) throw new Error('standard-no-audio')
  return b64
}

// Forvo (real native-speaker recordings). Free/legacy host is apifree.forvo.com;
// commercial is apicommercial.forvo.com — override with FORVO_API_BASE.
const FORVO_API_BASE = process.env.FORVO_API_BASE || 'https://apifree.forvo.com'

/** Fetches the top-rated Forvo pronunciation for a word and returns it as base64 mp3. */
async function ttsForvo(text: string, language: string, apiKey: string): Promise<string> {
  const url = `${FORVO_API_BASE}/key/${apiKey}/format/json/action/word-pronunciations`
    + `/word/${encodeURIComponent(text)}/language/${encodeURIComponent(language)}/order/rate-desc/limit/1/`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Forvo ${res.status}: ${await res.text().catch(() => '')}`)
  const data = await res.json().catch(() => null)
  const mp3 = data?.items?.[0]?.pathmp3 as string | undefined
  if (!mp3) throw new Error('forvo-no-pronunciation')
  const audioRes = await fetch(mp3)
  if (!audioRes.ok) throw new Error(`Forvo audio ${audioRes.status}`)
  return Buffer.from(await audioRes.arrayBuffer()).toString('base64')
}

/**
 * Strips annotations that shouldn't be spoken — gender/number markers like "(f)",
 * "(m)", "(pl)", bracketed notes, and surrounding whitespace. Sending these to TTS
 * makes it try to vocalise the "(f)", garbling short words into nonsense. Falls back
 * to the original text if cleaning would empty it out.
 */
// Leading articles to drop for a Forvo *word* lookup: Forvo indexes the bare
// headword ("tos"), not "article + noun" ("la tos"), so an article card would
// otherwise almost always miss. Keyed by the language code's first two letters.
const LEADING_ARTICLES: Record<string, string[]> = {
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', "l'"],
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', "l'", "gl'"],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas'],
  ca: ['el', 'la', 'els', 'les', 'un', 'una', "l'"],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer'],
}

/** Strips a single leading definite/indefinite article for the given language, else returns the text unchanged. */
function stripLeadingArticle(text: string, language: string): string {
  const arts = LEADING_ARTICLES[language.slice(0, 2).toLowerCase()]
  if (!arts) return text
  const t = text.trim()
  for (const a of arts) {
    if (a.endsWith("'")) {                                   // elided: l'ufficio → ufficio
      const re = new RegExp(`^${a}`, 'i')
      if (re.test(t)) return t.replace(re, '').trim()
    }
  }
  const m = t.match(/^(\S+)\s+(.+)$/)                         // spaced: la tos → tos
  if (m && arts.includes(m[1]!.toLowerCase())) return m[2]!.trim()
  return t
}

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
// Leading pause to protect the onset (a short leading article like "el"/"la"/"le" is the phoneme
// most often clipped at the start). It renders as a brief silence, not spoken words. LEAD_PAD_SEC
// is roughly how much silence it adds — the duration guard's minimum is bumped by it so the guard
// still catches a clip of the actual speech rather than being fooled by the pad's silence.
const ELEVEN_LEAD_PAD = '… '
const ELEVEN_LEAD_PAD_SEC = 0.28

async function ttsElevenLabs(text: string, language: string, apiKey: string): Promise<string> {
  // Pad the start (onset protection) AND end (phrase boundary).
  const withEnd = /[.!?…。]$/.test(text) ? text : `${text}.`
  const padded = `${ELEVEN_LEAD_PAD}${withEnd}`
  // Expected minimum seconds for a complete rendering (~50 ms per non-space character) + the lead pad.
  const minSec = Math.max(0.35, text.replace(/\s+/g, '').length * 0.05) + ELEVEN_LEAD_PAD_SEC

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

  const { text, language, source = 'elevenlabs', fallback = false } = body
  if (!text?.trim()) {
    return NextResponse.json({ ok: false, reason: 'bad-request' }, { status: 400 })
  }

  if (!TTS_SUPPORTED_LANGUAGES.has(language)) {
    return NextResponse.json({ ok: false, reason: 'unsupported-language' })
  }

  const speakText = cleanForSpeech(text)

  // ── Standard TTS: one pinned synthetic voice per language, identical for everyone ──
  // No fallback chain: if this is what you picked, a failure should say so rather than quietly
  // returning a different-sounding voice and reintroducing the inconsistency we're avoiding.
  if (source === 'standard') {
    const googleKey = process.env.GOOGLE_TTS_API_KEY
    if (!googleKey) return NextResponse.json({ ok: false, reason: 'no-google-tts-key' })
    try {
      const audioData = await ttsGoogleStandard(speakText, language, googleKey)
      return NextResponse.json({ ok: true, audioData, source: 'standard' })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'standard-failed'
      console.error('[tts] standard failed:', reason)
      return NextResponse.json({ ok: false, reason })
    }
  }

  // ── Forvo: real native-speaker recordings (coverage varies by language/word) ──
  // `fallback` (opt-in): on any Forvo miss, fall through to ElevenLabs instead of
  // failing, so a "prefer Forvo" request always returns audio. Without it (e.g. the
  // per-provider picker), a miss is reported honestly as `forvo-no-pronunciation`.
  let forvoMissReason: string | null = null
  if (source === 'forvo') {
    const forvoKey = process.env.FORVO_API_KEY
    if (!forvoKey) {
      if (!fallback) return NextResponse.json({ ok: false, reason: 'no-forvo-key' })
      forvoMissReason = 'no-forvo-key'
    } else {
      // Try the full phrase first (in case Forvo has it), then the bare headword
      // with any leading article stripped — Forvo indexes words, not "article + noun".
      const candidates = [speakText]
      const bare = stripLeadingArticle(speakText, language)
      if (bare && bare !== speakText) candidates.push(bare)
      for (const candidate of candidates) {
        try {
          const audioData = await ttsForvo(candidate, language, forvoKey)
          return NextResponse.json({ ok: true, audioData, source: 'forvo' })
        } catch (err) {
          if (err instanceof Error && err.message === 'forvo-no-pronunciation') { forvoMissReason = 'forvo-no-pronunciation'; continue }
          console.error('[TTS] forvo error', err)
          forvoMissReason = 'forvo-error'
          break  // network/API error → stop trying Forvo
        }
      }
      if (!fallback) return NextResponse.json({ ok: false, reason: forvoMissReason ?? 'forvo-no-pronunciation' })
    }
  }

  // ── ElevenLabs (default, and the Forvo fallback target), falling back to OpenAI ──
  const elevenKey = process.env.ELEVENLABS_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (!elevenKey && !openaiKey) {
    return NextResponse.json({ ok: false, reason: 'no-api-key' })
  }

  try {
    const audioData = elevenKey
      ? await ttsElevenLabs(speakText, language, elevenKey)
      : await ttsOpenAI(speakText, openaiKey!)
    // Tag when this clip is a Forvo→ElevenLabs fallback so the caller can label it.
    return NextResponse.json({ ok: true, audioData, source: 'elevenlabs', ...(forvoMissReason ? { fellBackFrom: 'forvo', forvoMissReason } : {}) })
  } catch (err) {
    console.error('[TTS] error', err)
    return NextResponse.json({ ok: false, reason: 'api-error' })
  }
}
