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

function playClip(src: string): Promise<void> {
  const audio = new Audio(src)
  audio.playbackRate = audioPlaybackRate
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
): Promise<{ audioData: string | null; reason?: string }> {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language, source }),
    })
    const data = await res.json()
    if (data.ok && data.audioData) return { audioData: data.audioData as string }
    return { audioData: null, reason: data.reason as string | undefined }
  } catch {
    return { audioData: null, reason: 'network-error' }
  }
}

export async function speakViaTts(text: string, language: string): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language }),
    })
    const data = await res.json()
    if (data.ok && data.audioData) {
      playClip(`data:audio/mp3;base64,${data.audioData}`).catch(() => {})
      return data.audioData as string
    }
  } catch { /* fall through to caller's fallback */ }
  return null
}
