// Maps app language codes to BCP 47 tags where the 2-letter code alone
// isn't enough for the Web Speech API to pick the right voice.
const SPEECH_LANG: Record<string, string> = {
  zh: 'zh-CN',
  pt: 'pt-BR',
}

/**
 * Speaks `text` aloud using the browser's built-in Web Speech API.
 * Cancels any currently-playing speech first.
 * No-ops on environments that don't support speechSynthesis (SSR, old browsers).
 */
export function speak(text: string, langCode: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = SPEECH_LANG[langCode] ?? langCode
  window.speechSynthesis.speak(utt)
}
