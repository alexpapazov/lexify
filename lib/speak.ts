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

// Audio source config (profile-level). Global default + per-language overrides. 'browser' (robotic,
// the default) generates no audio — playback uses the on-device speech synth. 'elevenlabs'/'forvo'
// pre-generate & play real clips (forvo auto-falls back to ElevenLabs). Per-card choices still win.
export type AudioSourceDefault = 'browser' | 'elevenlabs' | 'forvo'
const isSource = (s: unknown): s is AudioSourceDefault => s === 'browser' || s === 'elevenlabs' || s === 'forvo'
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
  utt.lang = SPEECH_LANG[langCode] ?? langCode
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
  text: string, language: string, source: 'elevenlabs' | 'forvo',
  fallback = false,
): Promise<{ audioData: string | null; source?: 'elevenlabs' | 'forvo'; fellBackFrom?: string; reason?: string }> {
  try {
    const res = await fetch('/api/tts', {
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
    const res = await fetch('/api/tts', {
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
