import { apiUrl } from '@/lib/apiBase'
// Maps app language codes to BCP 47 tags where the 2-letter code alone
// isn't enough for the Web Speech API to pick the right voice.
const SPEECH_LANG: Record<string, string> = {
  zh: 'zh-CN',
  pt: 'pt-BR',
}

/** Strips gender/number/notes annotations — "(f)", "(m)", "[note]" — that shouldn't be
 *  spoken or graded. Falls back to the original if stripping empties it. */
export function stripAnnotations(text: string): string {
  const cleaned = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || text.trim()
}

// Current audio playback speed (per-deck setting). Pages set this from the deck's
// preferences when they load; `speak` applies it to both cached audio (via
// playbackRate, pitch preserved) and the Web Speech fallback (via utterance rate).
let audioPlaybackRate = 1
export function setAudioPlaybackRate(rate: number): void {
  audioPlaybackRate = Number.isFinite(rate) && rate > 0 ? rate : 1
}

// Per-deck audio volume as a GAIN: 0–2, where 1 = normal and 2 = twice as loud. Values above 1
// can't be done with `audio.volume` (capped at 1), so `playClip` routes those through a Web Audio
// gain node. Pages set this from the deck's preferences on load.
let audioVolume = 1
export function setAudioVolume(vol: number): void {
  audioVolume = Number.isFinite(vol) ? Math.min(2, Math.max(0, vol)) : 1
}

// ─── Device-voice selection (the non-AI path) ────────────────────────────────
// The OS ships a cheap "compact" voice per language and lets you download a much better
// Enhanced/Premium one. Both are exposed to the Web Speech API, and the browser default is usually the
// compact one — so the good voice only gets used if we ASK for it by name. That's what this does.

/** Quality hints that appear in voice names across platforms, best first. */
const VOICE_TIERS: { match: RegExp; score: number }[] = [
  { match: /premium/i,            score: 100 },  // Apple, downloadable — the best on-device option
  { match: /enhanced/i,           score: 90 },   // Apple, downloadable
  { match: /neural|natural/i,     score: 80 },   // Edge/Windows
  { match: /siri/i,               score: 70 },
  { match: /google/i,             score: 40 },   // Chrome's bundled voices — decent, usually remote
]

let voiceCache: SpeechSynthesisVoice[] = []
function allVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !window.speechSynthesis) return []
  // getVoices() is empty until the list loads, and fires `voiceschanged` when it's ready — so refresh
  // the cache whenever it's currently empty rather than caching an empty list forever.
  if (voiceCache.length === 0) voiceCache = window.speechSynthesis.getVoices()
  return voiceCache
}
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.addEventListener?.('voiceschanged', () => { voiceCache = window.speechSynthesis.getVoices() })
}

/**
 * The best installed voice for a BCP-47 tag: highest quality tier wins, then an exact region match
 * (es-MX over es-ES when asked for es-MX), then on-device voices — which on Apple platforms are
 * exactly the downloaded Enhanced/Premium ones, and also work offline. Null → let the browser decide.
 */
export function bestVoiceFor(lang: string): SpeechSynthesisVoice | null {
  const base = lang.split('-')[0]!.toLowerCase()
  const candidates = allVoices().filter(v => v.lang?.toLowerCase().replace('_', '-').startsWith(base))
  if (candidates.length === 0) return null
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0
    for (const t of VOICE_TIERS) if (t.match.test(v.name)) { s += t.score; break }
    if (v.lang?.toLowerCase().replace('_', '-') === lang.toLowerCase()) s += 15
    if (v.localService) s += 10
    return s
  }
  return candidates.reduce((best, v) => (score(v) > score(best) ? v : best), candidates[0]!)
}

/** Human-readable name of the voice actually in use for a language (for the Settings readout). */
export function voiceNameFor(langCode: string): string | null {
  const lang = SPEECH_LANG[langCode] ?? langCode
  return bestVoiceFor(lang)?.name ?? null
}

// Audio source config (profile-level). Global default + per-language overrides. 'browser' (robotic,
// the default) generates no audio — playback uses the on-device speech synth. 'elevenlabs'/'forvo'
// pre-generate & play real clips (forvo auto-falls back to ElevenLabs). Per-card choices still win.
export type AudioSourceDefault = 'browser' | 'elevenlabs' | 'forvo' | 'standard'
const isSource = (s: unknown): s is AudioSourceDefault => s === 'browser' || s === 'elevenlabs' || s === 'forvo' || s === 'standard'
let audioSourceDefault: AudioSourceDefault = 'browser'
let audioSourceByLanguage: Record<string, AudioSourceDefault> = {}
export function setAudioSourceDefault(src: string | null | undefined): void {
  audioSourceDefault = isSource(src) ? src : 'browser'
}
export function setAudioSourceByLanguage(map: Record<string, string> | null | undefined): void {
  const clean: Record<string, AudioSourceDefault> = {}
  for (const [lang, src] of Object.entries(map ?? {})) if (isSource(src)) clean[lang] = src
  audioSourceByLanguage = clean
}
/** The effective source for a language: its per-language override, else the global default. */
export function getAudioSourceForLanguage(language: string): AudioSourceDefault {
  return audioSourceByLanguage[language] ?? audioSourceDefault
}

// Reused across clips so we don't leak an AudioContext per play. Only created when gain > 1.
let audioCtx: AudioContext | null = null

function playClip(src: string): Promise<void> {
  const audio = new Audio(src)
  audio.playbackRate = audioPlaybackRate
  // Keep pitch natural when slowed/sped (Safari uses the webkit-prefixed flag).
  audio.preservesPitch = true
  ;(audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
  if (audioVolume <= 1) {
    audio.volume = audioVolume
  } else {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx ??= new Ctx()
      if (audioCtx.state === 'suspended') void audioCtx.resume()
      const srcNode = audioCtx.createMediaElementSource(audio)
      const gainNode = audioCtx.createGain()
      gainNode.gain.value = audioVolume
      srcNode.connect(gainNode).connect(audioCtx.destination)
    } catch { audio.volume = 1 }
  }
  return audio.play()
}

/** Plays a base64 mp3 clip at the current deck speed. Returns the play promise so
 *  callers can surface autoplay/decoding errors. */
export function playAudioClip(base64: string): Promise<void> {
  return playClip(`data:audio/mp3;base64,${base64}`)
}

/**
 * Plays audio for `text` in `langCode`.
 * If `audioData` (base64 mp3 from ElevenLabs, cached on the card) is provided,
 * plays that directly — best quality, works everywhere.
 * Falls back to the browser Web Speech API when no cached audio exists.
 */
export function speak(text: string, langCode: string, audioData?: string | null): void {
  if (typeof window === 'undefined') return

  if (audioData) {
    playClip(`data:audio/mp3;base64,${audioData}`).catch(() => {})
    return
  }

  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel()
  // Don't speak "(f)"/"(m)"/notes — they garble the robotic voice.
  const utt = new SpeechSynthesisUtterance(stripAnnotations(text))
  const lang = SPEECH_LANG[langCode] ?? langCode
  utt.lang = lang
  // Pick the best installed voice explicitly. Setting only `lang` makes the browser use its DEFAULT
  // voice for that language, which on Apple platforms is the low-quality "compact" one — so a
  // downloaded Enhanced/Premium voice would sit there unused and everything would still sound robotic.
  const voice = bestVoiceFor(lang)
  if (voice) utt.voice = voice
  utt.rate = audioPlaybackRate
  utt.volume = Math.min(1, audioVolume)   // Web Speech volume can't exceed 1 (no >100% for robotic)
  window.speechSynthesis.speak(utt)
}

/**
 * Generates audio on demand via the ElevenLabs-backed TTS route, plays it, and
 * returns the base64 so the caller can cache it on the card. Returns null if the
 * language isn't supported or generation fails (caller should fall back to `speak`).
 */
/**
 * Fetches a specific audio source's clip (base64 mp3) WITHOUT playing it — used by
 * the card audio picker to fetch/cache each provider's candidate. Returns null (with
 * a reason) when unavailable (e.g. Forvo has no recording for the word).
 */
export async function fetchAudioSource(
  text: string, language: string, source: 'elevenlabs' | 'forvo' | 'standard',
  fallback = false,
): Promise<{ audioData: string | null; source?: 'elevenlabs' | 'forvo' | 'standard'; fellBackFrom?: string; reason?: string }> {
  try {
    const res = await fetch(apiUrl('/api/tts'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language, source, fallback }),
    })
    const data = await res.json()
    if (data.ok && data.audioData) {
      return { audioData: data.audioData as string, source: data.source, fellBackFrom: data.fellBackFrom }
    }
    return { audioData: null, reason: data.reason as string | undefined }
  } catch {
    return { audioData: null, reason: 'network-error' }
  }
}

export async function speakViaTts(text: string, language: string): Promise<string | null> {
  if (typeof window === 'undefined') return null
  const source = getAudioSourceForLanguage(language)
  // Robotic default → don't generate a clip; the caller falls back to on-device speech.
  if (source === 'browser') return null
  try {
    const res = await fetch(apiUrl('/api/tts'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Use the effective source for this language; Forvo auto-falls back to ElevenLabs when it has no recording.
      body: JSON.stringify({ text, language, source, fallback: source === 'forvo' }),
    })
    const data = await res.json()
    if (data.ok && data.audioData) {
      playClip(`data:audio/mp3;base64,${data.audioData}`).catch(() => {})
      return data.audioData as string
    }
  } catch { /* fall through to caller's fallback */ }
  return null
}

// In-session cache of on-demand clips so repeat plays of the same card don't re-fetch.
const cardClipCache = new Map<string, string>()

/**
 * Plays a card's TARGET word (card.front) with the best available voice — the same path dictation
 * uses, so MCQ/flashcard get a real native clip instead of the browser's wrong-language voice:
 *   • audioSource 'browser' → on-device speech (for languages you set to Robotic);
 *   • a cached clip (on the card, or fetched earlier this session) → play it;
 *   • otherwise fetch a real clip via the TTS route (respecting the per-language source), cache it,
 *     and fall back to on-device speech only if that fails / the language is set to Robotic.
 */
export function speakCard(
  card: { id: string; front: string; audioData?: string | null; audioSource?: string | null },
  language: string,
): void {
  if (typeof window === 'undefined') return
  if (card.audioSource === 'browser') { speak(card.front, language, null); return }
  if (card.audioData)                 { speak(card.front, language, card.audioData); return }
  const cached = cardClipCache.get(card.id)
  if (cached)                         { speak(card.front, language, cached); return }
  void speakViaTts(card.front, language).then(b64 => {
    if (b64) cardClipCache.set(card.id, b64)   // speakViaTts already played it
    else speak(card.front, language, null)     // Robotic source or fetch failed → on-device voice
  })
}
