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

// Per-deck audio volume (0–1). Pages set this from the deck's preferences on load;
// `speak`/`playClip` apply it to cached-clip playback and the Web Speech fallback.
let audioVolume = 1
export function setAudioVolume(vol: number): void {
  audioVolume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1
}

// Global default audio source (profile-level). 'browser' (robotic, the default) generates no
// audio — playback uses the on-device speech synth. 'elevenlabs'/'forvo' pre-generate & play real
// clips (forvo auto-falls back to ElevenLabs when it has no recording). Pages set this from the
// profile on load; per-card audio choices still override this for individual cards.
export type AudioSourceDefault = 'browser' | 'elevenlabs' | 'forvo'
let audioSourceDefault: AudioSourceDefault = 'browser'
export function setAudioSourceDefault(src: string | null | undefined): void {
  audioSourceDefault = src === 'elevenlabs' || src === 'forvo' ? src : 'browser'
}
export function getAudioSourceDefault(): AudioSourceDefault { return audioSourceDefault }

function playClip(src: string): Promise<void> {
  const audio = new Audio(src)
  audio.playbackRate = audioPlaybackRate
  audio.volume = audioVolume
  // Keep pitch natural when slowed/sped (Safari uses the webkit-prefixed flag).
  audio.preservesPitch = true
  ;(audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
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
  utt.volume = audioVolume
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
  // Robotic default → don't generate a clip; the caller falls back to on-device speech.
  if (audioSourceDefault === 'browser') return null
  try {
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Use the chosen default source; Forvo auto-falls back to ElevenLabs when it has no recording.
      body: JSON.stringify({ text, language, source: audioSourceDefault, fallback: audioSourceDefault === 'forvo' }),
    })
    const data = await res.json()
    if (data.ok && data.audioData) {
      playClip(`data:audio/mp3;base64,${data.audioData}`).catch(() => {})
      return data.audioData as string
    }
  } catch { /* fall through to caller's fallback */ }
  return null
}
