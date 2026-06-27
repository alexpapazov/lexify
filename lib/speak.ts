// Maps app language codes to BCP 47 tags where the 2-letter code alone
// isn't enough for the Web Speech API to pick the right voice.
const SPEECH_LANG: Record<string, string> = {
  zh: 'zh-CN',
  pt: 'pt-BR',
}

/**
 * Plays audio for `text` in `langCode`.
 * If `audioData` (base64 mp3 from OpenAI TTS) is provided, plays that
 * directly — better quality, works on all platforms.
 * Falls back to the browser Web Speech API when no cached audio exists.
 */
export function speak(text: string, langCode: string, audioData?: string | null): void {
  return // TEMP: audio disabled for troubleshooting
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
