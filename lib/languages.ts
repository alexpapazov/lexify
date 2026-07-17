export interface Language { code: string; name: string; nativeName: string; flag: string }

export const LANGUAGES: Language[] = [
  { code: 'en',  name: 'English',     nativeName: 'English',          flag: '🇺🇸' },
  { code: 'es',  name: 'Spanish',     nativeName: 'Español',          flag: '🇪🇸' },
  { code: 'fr',  name: 'French',      nativeName: 'Français',         flag: '🇫🇷' },
  { code: 'de',  name: 'German',      nativeName: 'Deutsch',          flag: '🇩🇪' },
  { code: 'it',  name: 'Italian',     nativeName: 'Italiano',         flag: '🇮🇹' },
  { code: 'pt',  name: 'Portuguese',  nativeName: 'Português',        flag: '🇵🇹' },
  { code: 'nl',  name: 'Dutch',       nativeName: 'Nederlands',       flag: '🇳🇱' },
  { code: 'ru',  name: 'Russian',     nativeName: 'Русский',          flag: '🇷🇺' },
  { code: 'zh',  name: 'Chinese',     nativeName: '中文',             flag: '🇨🇳' },
  { code: 'ja',  name: 'Japanese',    nativeName: '日本語',           flag: '🇯🇵' },
  { code: 'ko',  name: 'Korean',      nativeName: '한국어',           flag: '🇰🇷' },
  { code: 'ar',  name: 'Arabic',      nativeName: 'العربية',          flag: '🇸🇦' },
  { code: 'hi',  name: 'Hindi',       nativeName: 'हिंदी',           flag: '🇮🇳' },
  { code: 'tr',  name: 'Turkish',     nativeName: 'Türkçe',           flag: '🇹🇷' },
  { code: 'pl',  name: 'Polish',      nativeName: 'Polski',           flag: '🇵🇱' },
  { code: 'sv',  name: 'Swedish',     nativeName: 'Svenska',          flag: '🇸🇪' },
  { code: 'no',  name: 'Norwegian',   nativeName: 'Norsk',            flag: '🇳🇴' },
  { code: 'da',  name: 'Danish',      nativeName: 'Dansk',            flag: '🇩🇰' },
  { code: 'fi',  name: 'Finnish',     nativeName: 'Suomi',            flag: '🇫🇮' },
  { code: 'el',  name: 'Greek',       nativeName: 'Ελληνικά',         flag: '🇬🇷' },
  { code: 'he',  name: 'Hebrew',      nativeName: 'עברית',            flag: '🇮🇱' },
  { code: 'uk',  name: 'Ukrainian',   nativeName: 'Українська',       flag: '🇺🇦' },
  { code: 'bg',  name: 'Bulgarian',   nativeName: 'Български',        flag: '🇧🇬' },
  { code: 'cs',  name: 'Czech',       nativeName: 'Čeština',          flag: '🇨🇿' },
  { code: 'hu',  name: 'Hungarian',   nativeName: 'Magyar',           flag: '🇭🇺' },
  { code: 'ro',  name: 'Romanian',    nativeName: 'Română',           flag: '🇷🇴' },
  { code: 'vi',  name: 'Vietnamese',  nativeName: 'Tiếng Việt',       flag: '🇻🇳' },
  { code: 'th',  name: 'Thai',        nativeName: 'ภาษาไทย',          flag: '🇹🇭' },
  { code: 'id',  name: 'Indonesian',  nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ms',  name: 'Malay',       nativeName: 'Bahasa Melayu',    flag: '🇲🇾' },
  { code: 'asl', name: 'ASL',         nativeName: 'ASL',              flag: '🇺🇸' },
  { code: 'bsl', name: 'BSL',         nativeName: 'BSL',              flag: '🇬🇧' },
]

/**
 * Language codes known to be well-supported by OpenAI TTS (tts-1 model).
 * Sign languages (asl, bsl) and any language not in this set should not
 * trigger audio generation — the model won't produce accurate output.
 */
export const TTS_SUPPORTED_LANGUAGES = new Set([
  'en','es','fr','de','it','pt','nl','ru','zh','ja','ko',
  'ar','hi','tr','pl','sv','no','da','fi','el','he','uk',
  'bg','cs','hu','ro','vi','th','id','ms',
])

export function langName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase()
}

export function langNativeName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.nativeName ?? code.toUpperCase()
}

export function langFlag(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.flag ?? '🌐'
}

/** Curated palette for per-language colors (analytics, etc.). */
export const LANG_COLOR_PALETTE = [
  '#7c6af7', '#f59e0b', '#10b981', '#6366f1', '#ec4899', '#14b8a6',
  '#f43f5e', '#a3e635', '#3b82f6', '#eab308', '#22c55e', '#a855f7',
]

/** A stable default color for a language, derived deterministically from its code
 *  so the same language always gets the same color until the user overrides it. */
export function defaultLanguageColor(code: string): string {
  let h = 0
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0
  return LANG_COLOR_PALETTE[h % LANG_COLOR_PALETTE.length]!
}

/** The color for a language: the user's chosen override (a #rrggbb hex) if valid, else the default. */
export function languageColor(code: string, overrides?: Record<string, string> | null): string {
  const o = overrides?.[code]
  return o && /^#[0-9a-fA-F]{6}$/.test(o) ? o : defaultLanguageColor(code)
}

const isHex = (s?: string): s is string => !!s && /^#[0-9a-fA-F]{6}$/.test(s)

/**
 * Resolves a color for every language in `codes` such that no two get the same DEFAULT color
 * (as far as the palette allows). Valid overrides are honored as-is; the rest are handed distinct
 * palette colors (skipping any already taken by an override or an earlier assignment). Deterministic
 * for a given set of codes + overrides (codes are sorted first), so the mapping is stable.
 */
export function assignLanguageColors(codes: string[], overrides?: Record<string, string> | null): Record<string, string> {
  const sorted = [...new Set(codes)].sort()
  const result: Record<string, string> = {}
  const used = new Set<string>()
  for (const code of sorted) {
    if (isHex(overrides?.[code])) { result[code] = overrides![code]!; used.add(result[code]!.toLowerCase()) }
  }
  let idx = 0
  for (const code of sorted) {
    if (result[code]) continue
    let color = LANG_COLOR_PALETTE[idx % LANG_COLOR_PALETTE.length]!
    for (let t = 0; used.has(color.toLowerCase()) && t < LANG_COLOR_PALETTE.length; t++) {
      idx++; color = LANG_COLOR_PALETTE[idx % LANG_COLOR_PALETTE.length]!
    }
    result[code] = color
    used.add(color.toLowerCase())
    idx++
  }
  return result
}
