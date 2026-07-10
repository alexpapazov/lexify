// Maps app language codes to BCP 47 tags where the 2-letter code alone
// isn't enough for the Web Speech API to pick the right voice.
const SPEECH_LANG: Record<string, string> = {
  zh: 'zh-CN',
  pt: 'pt-BR',
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
    const audio = new Audio(`data:audio/mp3;base64,${audioData}`)
    audio.play().catch(() => {})
    return
  }

  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = SPEECH_LANG[langCode] ?? langCode
  window.speechSynthesis.speak(utt)
}

/**
 * Generates audio on demand via the ElevenLabs-backed TTS route, plays it, and
 * returns the base64 so the caller can cache it on the card. Returns null if the
 * language isn't supported or generation fails (caller should fall back to `speak`).
 */
export async function speakViaTts(text: string, language: string): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch('/api/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, language }),
    })
    const data = await res.json()
    if (data.ok && data.audioData) {
      new Audio(`data:audio/mp3;base64,${data.audioData}`).play().catch(() => {})
      return data.audioData as string
    }
  } catch { /* fall through to caller's fallback */ }
  return null
}
