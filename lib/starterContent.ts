// Starter content seeded at onboarding: a "Common Phrases" folder (5 phrases) and a
// "Numbers" folder (1–5) for each language the learner adds — so they have something to
// study during the tutorial. Cards are front = target-language word, back = native gloss,
// so we translate each concept into BOTH the learned and native language. Languages we
// don't have accurate translations for are skipped (no starter folder).

type Concept =
  | 'hello' | 'goodbye' | 'thank_you' | 'please' | 'sorry'
  | 'one' | 'two' | 'three' | 'four' | 'five'

const PHRASE_CONCEPTS: Concept[] = ['hello', 'goodbye', 'thank_you', 'please', 'sorry']
const NUMBER_CONCEPTS: Concept[] = ['one', 'two', 'three', 'four', 'five']

// concept → language code → word (curated; accuracy-checked for these languages only).
const WORDS: Record<Concept, Record<string, string>> = {
  hello:     { en: 'hello',      es: 'hola',       fr: 'bonjour',      de: 'hallo',          it: 'ciao',         pt: 'olá',       nl: 'hallo',       ru: 'привет',       uk: 'привіт',       pl: 'cześć',      cs: 'ahoj',         ro: 'salut',       sv: 'hej',    tr: 'merhaba',      el: 'γεια',    bg: 'здравей',    ja: 'こんにちは',   ko: '안녕하세요', zh: '你好' },
  goodbye:   { en: 'goodbye',    es: 'adiós',      fr: 'au revoir',    de: 'tschüss',        it: 'arrivederci',  pt: 'adeus',     nl: 'doei',        ru: 'до свидания',  uk: 'до побачення', pl: 'do widzenia', cs: 'na shledanou', ro: 'la revedere', sv: 'hej då', tr: 'hoşça kal',    el: 'αντίο',   bg: 'довиждане',  ja: 'さようなら',   ko: '안녕히 가세요', zh: '再见' },
  thank_you: { en: 'thank you',  es: 'gracias',    fr: 'merci',        de: 'danke',          it: 'grazie',       pt: 'obrigado',  nl: 'dank je',     ru: 'спасибо',      uk: 'дякую',        pl: 'dziękuję',   cs: 'děkuji',       ro: 'mulțumesc',   sv: 'tack',   tr: 'teşekkürler',  el: 'ευχαριστώ', bg: 'благодаря', ja: 'ありがとう',   ko: '감사합니다', zh: '谢谢' },
  please:    { en: 'please',     es: 'por favor',  fr: "s'il vous plaît", de: 'bitte',       it: 'per favore',   pt: 'por favor', nl: 'alsjeblieft', ru: 'пожалуйста',   uk: 'будь ласка',   pl: 'proszę',     cs: 'prosím',       ro: 'te rog',      sv: 'snälla', tr: 'lütfen',       el: 'παρακαλώ', bg: 'моля',      ja: 'お願いします', ko: '부탁합니다', zh: '请' },
  sorry:     { en: 'sorry',      es: 'lo siento',  fr: 'désolé',       de: 'entschuldigung', it: 'scusa',        pt: 'desculpa',  nl: 'sorry',       ru: 'извините',     uk: 'вибачте',      pl: 'przepraszam', cs: 'promiň',      ro: 'scuze',       sv: 'förlåt', tr: 'özür dilerim', el: 'συγγνώμη', bg: 'извинявай', ja: 'ごめんなさい', ko: '죄송합니다', zh: '对不起' },
  one:       { en: 'one',   es: 'uno',    fr: 'un',      de: 'eins',  it: 'uno',     pt: 'um',    nl: 'een',  ru: 'один',    uk: 'один',    pl: 'jeden', cs: 'jeden', ro: 'unu',  sv: 'ett',  tr: 'bir',  el: 'ένα',     bg: 'едно',   ja: '一', ko: '하나', zh: '一' },
  two:       { en: 'two',   es: 'dos',    fr: 'deux',    de: 'zwei',  it: 'due',     pt: 'dois',  nl: 'twee', ru: 'два',     uk: 'два',     pl: 'dwa',   cs: 'dva',   ro: 'doi',  sv: 'två',  tr: 'iki',  el: 'δύο',     bg: 'две',    ja: '二', ko: '둘',   zh: '二' },
  three:     { en: 'three', es: 'tres',   fr: 'trois',   de: 'drei',  it: 'tre',     pt: 'três',  nl: 'drie', ru: 'три',     uk: 'три',     pl: 'trzy',  cs: 'tři',   ro: 'trei', sv: 'tre',  tr: 'üç',   el: 'τρία',    bg: 'три',    ja: '三', ko: '셋',   zh: '三' },
  four:      { en: 'four',  es: 'cuatro', fr: 'quatre',  de: 'vier',  it: 'quattro', pt: 'quatro',nl: 'vier', ru: 'четыре',  uk: 'чотири',  pl: 'cztery',cs: 'čtyři', ro: 'patru',sv: 'fyra', tr: 'dört', el: 'τέσσερα', bg: 'четири', ja: '四', ko: '넷',   zh: '四' },
  five:      { en: 'five',  es: 'cinco',  fr: 'cinq',    de: 'fünf',  it: 'cinque',  pt: 'cinco', nl: 'vijf', ru: 'пять',    uk: "п'ять",   pl: 'pięć',  cs: 'pět',   ro: 'cinci',sv: 'fem',  tr: 'beş',  el: 'πέντε',   bg: 'пет',    ja: '五', ko: '다섯', zh: '五' },
}

/** Languages we have a full starter set for (present in every concept above). */
export function hasStarterContent(code: string): boolean {
  return code in WORDS.hello
}

export interface StarterFolder {
  name: string
  cards: { front: string; back: string }[]  // front = learned, back = native
}

/**
 * The two starter folders (Common Phrases, Numbers) for a learned→native pair, or an
 * empty array if either language lacks a curated set.
 */
export function starterFoldersFor(learned: string, native: string): StarterFolder[] {
  if (!hasStarterContent(learned) || !hasStarterContent(native)) return []
  const build = (concepts: Concept[]) =>
    concepts.map(c => ({ front: WORDS[c][learned]!, back: WORDS[c][native]! }))
  return [
    { name: 'Common Phrases', cards: build(PHRASE_CONCEPTS) },
    { name: 'Numbers',        cards: build(NUMBER_CONCEPTS) },
  ]
}
