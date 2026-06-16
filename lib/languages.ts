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

export function langName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase()
}

export function langNativeName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.nativeName ?? code.toUpperCase()
}

export function langFlag(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.flag ?? '🌐'
}
