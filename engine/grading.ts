/**
 * engine/grading.ts
 * Pure functions for normalizing and grading typed answers.
 * No imports from React, Next.js, Supabase, or any I/O layer.
 *
 * Three grading modes:
 *   strict    — case-insensitive only; slash alternatives accepted; no accent/
 *               article/typo leniency; no "almost" state.
 *   flexible  — user-configured toggles; produces "almost" for near-misses.
 *   smart_ai  — scaffolded; falls back to flexible until AI backend is wired.
 */

import type {
  GradingSettings, GradingResult, GradingIssueType, GradingStatus,
  TypedStrictness, TypedStrictnessLevel, TypedPenalty, TypedErrorCategory,
} from '@/domain'
import { TYPED_PENALTY_WEIGHTS } from '@/domain'

// ─── String utilities ──────────────────────────────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function containsHangul(s: string): boolean {
  return /[가-힣]/.test(s)
}

type ScriptFamily = 'latin' | 'hangul' | 'cjk' | 'cyrillic' | 'arabic' | 'hebrew' | 'devanagari' | 'thai'

/**
 * Infers the dominant script family from a string.
 * Used to select the right "almost" thresholds for each language.
 * Checked in priority order so mixed-script strings resolve sensibly.
 */
function detectScript(s: string): ScriptFamily {
  if (/[가-힣]/.test(s))                         return 'hangul'
  if (/[一-鿿぀-ヿ]/.test(s))   return 'cjk'       // CJK + kana
  if (/[؀-ۿ]/.test(s))                 return 'arabic'
  if (/[֐-׿]/.test(s))                 return 'hebrew'
  if (/[ऀ-ॿ]/.test(s))                 return 'devanagari' // Hindi
  if (/[฀-๿]/.test(s))                 return 'thai'
  if (/[Ѐ-ԯ]/.test(s))                 return 'cyrillic'
  return 'latin'
}

/**
 * Decomposes Hangul syllable blocks into constituent jamo (consonants + vowels).
 * 당 (ㄷ+ㅏ+ㅇ) becomes 3 jamo characters, giving accurate Levenshtein distance
 * for Korean text. Non-Hangul characters pass through unchanged.
 */
function decomposeHangul(s: string): string {
  const BASE    = 0xAC00
  const INITIAL = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
  const VOWEL   = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ']
  const FINAL   = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
  let result = ''
  for (const char of s) {
    const code = char.codePointAt(0)!
    if (code >= BASE && code < BASE + 11172) {
      const offset = code - BASE
      result += INITIAL[Math.floor(offset / 588)]! +
                VOWEL[Math.floor((offset % 588) / 28)]! +
                (offset % 28 > 0 ? FINAL[offset % 28]! : '')
    } else {
      result += char
    }
  }
  return result
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!
      } else {
        dp[i]![j] = 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
      }
    }
  }
  return dp[m]![n]!
}

/**
 * Expands "hacer (algo)" into ["hacer algo", "hacer"].
 * Returns [s] unchanged when no parenthetical is present.
 */
function expandParentheticals(s: string): string[] {
  const match = /\(([^)]+)\)/.exec(s)
  if (!match) return [s]
  const withContent    = s.replace(/\(([^)]+)\)/, '$1').replace(/\s+/g, ' ').trim()
  const withoutContent = s.replace(/\([^)]+\)/, '').replace(/\s+/g, ' ').trim()
  return [withContent, withoutContent]
}

const ARTICLES_BY_LANG: Record<string, string[]> = {
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
  fr: ["l'", 'le', 'la', 'les', 'un', 'une', 'des', 'du'],
  it: ["l'", 'lo', 'il', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines'],
  // Greek declines its definite article, so all three cases are listed — a card may store
  // "το απόγευμα" (nom.) or "της Ελλάδας" (gen.). Without these, `hintPlan` treated the article as
  // the content word and its two hint levels just spelled it out ("τ", "το"), revealing nothing.
  // Indefinite forms appear both accented and bare because `normalizeFlexible` strips accents BEFORE
  // calling here when `ignoreAccents` is on, so only the bare form would match at grading time.
  el: [
    'ο', 'η', 'το', 'οι', 'τα',              // nominative
    'του', 'της', 'των',                     // genitive
    'τον', 'την', 'τους', 'τις',             // accusative (το/τα shared with nom.)
    'ένας', 'ενας', 'μία', 'μια', 'ένα', 'ενα', // indefinite
  ],
}
// Fallback when language is unknown — all articles from all supported languages
const ALL_ARTICLES = new Set(Object.values(ARTICLES_BY_LANG).flat())

function getArticleSet(lang?: string): Set<string> {
  if (lang) {
    const base = lang.toLowerCase().split(/[-_]/)[0]!
    const specific = ARTICLES_BY_LANG[base]
    if (specific) return new Set(specific)
  }
  return ALL_ARTICLES
}

export function stripLeadingArticle(s: string, lang?: string): string {
  const articles = getArticleSet(lang)
  const parts = s.split(/\s+/)
  const first = parts[0] ?? ''
  // Space-separated article: "il cane" → "cane".
  if (parts.length > 1 && articles.has(first.toLowerCase())) {
    return parts.slice(1).join(' ')
  }
  // Elided article attached by an apostrophe (no space): "l'acqua" → "acqua",
  // so the hint reveals the content word ("l'a…"), consistent with "il c…".
  // Apostrophe variants (straight/curly) are normalized before the lookup.
  const elided = first.match(/^(\p{L}+['’])(\p{L}.*)$/u)
  if (elided && articles.has(elided[1]!.replace(/['’]/g, "'").toLowerCase())) {
    return [elided[2]!, ...parts.slice(1)].join(' ')
  }
  return s
}

/**
 * The leading article actually present on a string, or '' — the exact counterpart of
 * `stripLeadingArticle`, recognising the same two forms.
 *
 * Must stay in step with that function. Naively taking `split(/\s+/)[0]` and testing it against the
 * article set works for "il cane" but silently fails for an ELIDED article: "l'attrezzo" has no space,
 * so the first "word" is the whole thing, no article is ever detected, and a plain misspelling inside
 * such a word gets reported as an article error.
 */
export function leadingArticle(s: string, lang?: string): string {
  const articles = getArticleSet(lang)
  const parts = s.split(/\s+/)
  const first = parts[0] ?? ''
  if (parts.length > 1 && articles.has(first.toLowerCase())) return first.toLowerCase()
  const elided = first.match(/^(\p{L}+['’])(\p{L}.*)$/u)
  if (elided) {
    const art = elided[1]!.replace(/['’]/g, "'").toLowerCase()
    if (articles.has(art)) return art
  }
  return ''
}

// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Canonicalizes apostrophe/quote variants to a straight ASCII apostrophe so a
 * typed "s'avérer" grades identically to a card storing "s'avérer" (curly).
 * Covers: ' ' (curly single quotes), ʼ (modifier letter apostrophe),
 * ´ ` (acute/grave used as apostrophes), ′ (prime).
 */
function unifyApostrophes(s: string): string {
  return s.replace(/[‘’ʼ´`′]/g, "'")
}

/**
 * Whether two strings are the SAME WORDING, ignoring only differences that carry no meaning:
 * apostrophe style (straight vs curly), Unicode composition, and spacing.
 *
 * Used to decide whether to show the learner "Card says: …" after a correct answer. That note exists
 * to reveal a genuinely different wording the card prefers — not to nag about a typographic variant.
 * Typing `l'agnello` against a card storing `l’agnello` is the same answer, and the grader already
 * agrees; comparing the raw strings made it look like a mismatch on every elided Italian article.
 *
 * Case is deliberately NOT folded: a capitalisation difference is a real difference in wording for
 * languages where it carries information (German nouns), so it stays worth surfacing.
 */
export function sameWording(a: string, b: string): boolean {
  const canon = (s: string) => unifyApostrophes(s).normalize('NFC').replace(/\s+/g, ' ').trim()
  return canon(a) === canon(b)
}

/** Flexible-mode normalization — applies only the enabled toggles. */
function normalizeFlexible(raw: string, settings: GradingSettings): string {
  let s = unifyApostrophes(raw.normalize('NFC')).trim().replace(/\s+/g, ' ')
  if (settings.ignoreCapitalization !== false) s = s.toLowerCase()
  if (settings.ignoreAccents)                  s = stripAccents(s)
  if (settings.ignoreDefiniteArticles)         s = stripLeadingArticle(s, settings.answerLanguage)
  return s
}

/** Strict-mode normalization — trim, collapse spaces, lowercase only. */
function normalizeStrict(raw: string): string {
  return unifyApostrophes(raw.normalize('NFC')).trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Public normalization entry point — used by TypingMode to compute the key
 * for persisted override entries. Uses the deck's active mode.
 */
export function normalizeAnswer(raw: string, settings: GradingSettings): string {
  const mode = settings.gradingMode ?? 'flexible'
  return mode === 'strict' ? normalizeStrict(raw) : normalizeFlexible(raw, settings)
}

// ─── GradingResult builders ────────────────────────────────────────────────────

function makeResult(
  status: GradingStatus,
  issueType: GradingIssueType,
  reason: string,
  typed: string,
  expected: string,
  normUser: string,
  normExp: string,
  matchedAnswer?: string,
): GradingResult {
  return {
    status, issueType, reason,
    typedAnswer: typed, expectedAnswer: expected,
    matchedAnswer,
    correct: status === 'correct',
    normalizedUser: normUser,
    normalizedExpected: normExp,
  }
}

// ─── Issue-type detection (for diagnostic info even on incorrect results) ──────

function detectIssueType(normUser: string, normExpected: string, lang?: string): GradingIssueType {
  if (!normUser) return 'none'
  if (stripAccents(normUser) === stripAccents(normExpected)) return 'accent'
  const userNoArticle = stripLeadingArticle(normUser, lang)
  const expNoArticle  = stripLeadingArticle(normExpected, lang)
  // Only classify as 'article' when the articles actually differ (not just the stems)
  if (userNoArticle === expNoArticle && userNoArticle !== normUser) return 'article'
  const dist   = levenshtein(normUser, normExpected)
  const maxLen = Math.max(normUser.length, normExpected.length, 1)
  if (dist / maxLen <= 0.34) return 'typo'
  return 'none'
}

// ─── Strict grading ────────────────────────────────────────────────────────────

function gradeStrict(userAnswer: string, expected: string, settings?: GradingSettings): GradingResult {
  const userNorm = normalizeStrict(userAnswer)

  // Split on slash/comma/semicolon alternatives unless the setting says to keep whole.
  const splitAlts = !settings || settings.slashAlternativesMode !== 'require_all'
  const slashParts = splitAlts ? expected.split(/\s*[\/,;]\s*/) : [expected]
  const candidates = [...new Set(slashParts.map(part =>
    normalizeStrict(part.replace(/\(([^)]+)\)/g, '$1').replace(/\s+/g, ' ').trim())
  ))]
  const normExp = candidates[0]!

  const matched = candidates.find(c => c === userNorm)
  if (matched !== undefined) {
    return makeResult('correct', 'none', '', userAnswer, expected, userNorm, normExp, matched)
  }

  // No "almost" in strict mode — just report the issue type for diagnostic display.
  const issueType = detectIssueType(userNorm, normExp, settings?.answerLanguage)
  return makeResult('incorrect', issueType, '', userAnswer, expected, userNorm, normExp)
}

// ─── Flexible grading ──────────────────────────────────────────────────────────

function buildFlexibleCandidates(expected: string, settings: GradingSettings): string[] {
  const slashParts = settings.slashAlternativesMode === 'accept_any'
    ? expected.split(/\s*[\/,;]\s*/)
    : [expected]

  const candidates: string[] = []
  for (const part of slashParts) {
    const trimmed = part.trim()
    if (!settings.requireParentheticalContent) {
      // Parenthetical content is optional — accept both forms.
      for (const variant of expandParentheticals(trimmed)) {
        candidates.push(normalizeFlexible(variant, settings))
      }
    } else {
      // Content inside parens is required — strip the parens, keep the text.
      const withContent = trimmed.replace(/\(([^)]+)\)/g, '$1').replace(/\s+/g, ' ').trim()
      candidates.push(normalizeFlexible(withContent, settings))
    }
  }
  return [...new Set(candidates)]
}

function gradeFlexible(userAnswer: string, expected: string, settings: GradingSettings): GradingResult {
  const normUser = normalizeFlexible(userAnswer, settings)
  const candidates = buildFlexibleCandidates(expected, settings)
  const normExp    = candidates[0]!

  // ── Exact normalized match ─────────────────────────────────────────────────
  const matched = candidates.find(c => c === normUser)
  if (matched !== undefined) {
    return makeResult('correct', 'none', '', userAnswer, expected, normUser, normExp, matched)
  }

  // ── "Almost" detection — only when the relevant toggle is OFF ──────────────

  // Accent-only difference (toggle is OFF, so accents weren't stripped during normalization)
  if (!settings.ignoreAccents) {
    const userNoAccent = stripAccents(normUser)
    if (candidates.some(c => stripAccents(c) === userNoAccent)) {
      return makeResult('almost', 'accent',
        'Your answer is missing or has an incorrect accent mark.',
        userAnswer, expected, normUser, normExp)
    }
  }

  // Missing required parenthetical content — must run before the article check so
  // '(el) camello' is diagnosed as 'parenthetical' rather than 'article'.
  if (settings.requireParentheticalContent && /\(/.test(expected)) {
    const slashParts = settings.slashAlternativesMode === 'accept_any'
      ? expected.split(/\s*[\/,;]\s*/)
      : [expected]
    for (const part of slashParts) {
      if (!/\(/.test(part)) continue
      const withoutParen = part.replace(/\([^)]+\)/g, '').replace(/\s+/g, ' ').trim()
      if (normalizeFlexible(withoutParen, settings) === normUser) {
        return makeResult('almost', 'parenthetical',
          'Your answer is missing the required parenthetical content.',
          userAnswer, expected, normUser, normExp)
      }
    }
  }

  // Article-only difference, or article omission combined with a minor typo.
  // e.g. "pengüino" vs "el pingüino": strip "el" → compare "pengüino" / "pingüino"
  // → dist 1, within typo threshold → 'almost' (article).
  if (!settings.ignoreDefiniteArticles) {
    const lang = settings.answerLanguage
    const userNoArticle = stripLeadingArticle(normUser, lang)
    const candidatesNoArticle = candidates.map(c => stripLeadingArticle(c, lang))
    const userArticle = leadingArticle(normUser, lang)

    // Pure article match — stems are identical, only article differs
    if (candidatesNoArticle.some(c => c === userNoArticle)) {
      return makeResult('almost', 'article',
        'Your answer is missing or has a different definite article.',
        userAnswer, expected, normUser, normExp)
    }

    // Article omission + minor typo: only check candidates that actually had an article,
    // and only when the user's article is absent or different from the expected article.
    const script = detectScript(normExp)
    const expand = (c: string) => script === 'hangul' ? decomposeHangul(c) : c
    const dUser = expand(userNoArticle)
    for (let i = 0; i < candidates.length; i++) {
      if (candidatesNoArticle[i] === candidates[i]) continue  // no article was stripped; skip
      const expectedArticle = leadingArticle(candidates[i]!, lang)
      // If user has the same article as expected, the stem is just a typo — not an article error
      if (userArticle === expectedArticle) continue
      const dExp  = expand(candidatesNoArticle[i]!)
      const dist  = levenshtein(dUser, dExp)
      const maxLen = Math.max(dUser.length, dExp.length, 1)
      const ratio = dist / maxLen
      const withinThreshold = dist > 0 && (() => {
        switch (script) {
          case 'latin':
          case 'hangul':    return dist === 1 || ratio <= 0.25
          case 'cyrillic':  return dist === 1 || ratio <= 0.20
          case 'cjk':       return dist === 1 && maxLen >= 3
          default:          return dist === 1
        }
      })()
      if (withinThreshold) {
        return makeResult('almost', 'article',
          'Your answer is missing or has a different definite article.',
          userAnswer, expected, normUser, normExp)
      }
    }
  }

  // Minor typo — threshold varies by script family so each language's "close enough"
  // reflects its actual phonology and orthography.
  //
  // Latin / Korean (jamo): dist=1, or dist>0 and ratio≤25%  (more forgiving)
  // Cyrillic:              dist=1, or dist>0 and ratio≤20%
  // CJK (Chinese/Japanese): dist=1 only, and word must be ≥3 chars (a wrong character
  //   in a 2-char Chinese/Japanese word is usually an entirely different word)
  // Arabic / Hebrew:       dist=1 only (diacritics already handled by accent check above)
  // Devanagari / Thai / default: dist=1 only
  //
  // Korean syllable blocks are decomposed to jamo before measuring distance so
  // 텔레비전 vs 테리비전 (2 jamo off out of 10 → 20%) correctly falls under "almost".
  // CJK strings are NOT decomposed — character-level distance is what matters there.
  // When ignoreMinorTypos=true the typo is forgiven and returns 'correct';
  // when false it returns 'almost' so the learner is notified.
  {
    const script = detectScript(normExp)
    const expand = (c: string) => script === 'hangul' ? decomposeHangul(c) : c
    const dUser   = expand(normUser)
    const dists   = candidates.map(c => levenshtein(dUser, expand(c)))
    const minDist = Math.min(...dists)
    const closestIdx = dists.indexOf(minDist)
    const maxLen  = Math.max(dUser.length, expand(candidates[closestIdx] ?? '').length, 1)
    const ratio   = minDist / maxLen

    const isAlmostTypo = minDist > 0 && (() => {
      switch (script) {
        case 'latin':
        case 'hangul':    return minDist === 1 || ratio < 0.25
        case 'cyrillic':  return minDist === 1 || ratio <= 0.20
        case 'cjk':       return minDist === 1 && maxLen >= 3
        default:          return minDist === 1
      }
    })()

    if (isAlmostTypo) {
      if (settings.ignoreMinorTypos || settings.isNativeAnswer) {
        return makeResult('correct', 'none', '',
          userAnswer, expected, normUser, normExp, candidates[closestIdx])
      }
      return makeResult('almost', 'typo',
        'Your answer has a minor spelling difference.',
        userAnswer, expected, normUser, normExp)
    }
  }

  // ── Incorrect ──────────────────────────────────────────────────────────────
  return makeResult('incorrect', detectIssueType(normUser, normExp, settings.answerLanguage), '',
    userAnswer, expected, normUser, normExp)
}

// ─── Smart AI grading (scaffold) ──────────────────────────────────────────────

/**
 * Scaffold for AI-assisted grading. Currently falls back to flexible grading.
 * When the AI backend is wired up, this function will:
 *   1. Call an async AI endpoint with the prompt, expected, typed, and
 *      settings.aiGradingInstructions.
 *   2. Parse a structured GradingResult from the response.
 *   3. Return that result.
 *
 * Note: because gradeTyping() is synchronous, AI grading will need either a
 * pre-flight async call or a separate async gradeTypingAsync() variant.
 */
function gradeSmartAI(userAnswer: string, expected: string, settings: GradingSettings): GradingResult {
  // TODO: replace with async AI call.
  return gradeFlexible(userAnswer, expected, settings)
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Grade a typed answer against the expected answer using the deck's grading mode.
 *
 * Returns a GradingResult with:
 *   status  — 'correct' | 'almost' | 'incorrect'
 *   reason  — human-readable explanation of any issue
 *   correct — true iff status === 'correct' (backward-compat alias)
 *
 * Scheduling defaults:
 *   correct   → Good
 *   almost    → Hard
 *   incorrect → Again
 */
/**
 * Grammatical gender/number tags — "(f)", "(m)", "(n)", "(pl)", "(f.)", "(masc)" … — are metadata,
 * never part of the typed answer, so they're stripped before grading (unlike required parentheticals
 * such as "(el) camello", whose content is a real word). Removes them from both sides regardless of
 * the `requireParentheticalContent` setting.
 */
const GRAMMATICAL_TAG = /\(\s*(?:m|f|n|mf|fm|masc|fem|neut|neutre|pl|sg|sing|plural|singular|masculine|feminine|neuter)\.?\s*\)/gi
export function stripGrammaticalTags(text: string): string {
  const cleaned = text.replace(GRAMMATICAL_TAG, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || text.trim()
}

export function gradeTyping(
  userAnswer: string,
  expected:   string,
  settings:   GradingSettings,
): GradingResult {
  userAnswer = stripGrammaticalTags(userAnswer)
  expected   = stripGrammaticalTags(expected)
  // Strip surrounding quotes — quoted backs are literal phrases (no comma/slash splitting).
  const eff = expected.length >= 2 && expected.startsWith('"') && expected.endsWith('"')
    ? expected.slice(1, -1)
    : expected
  const mode = settings.gradingMode ?? 'flexible'
  if (mode === 'strict')   return gradeStrict(userAnswer, eff, settings)
  if (mode === 'smart_ai') return gradeSmartAI(userAnswer, eff, settings)
  return gradeFlexible(userAnswer, eff, settings)
}

// ─── Per-category strictness → penalty ─────────────────────────────────────────

/**
 * Maps the loggable slip categories to the GradingResult.issueType values.
 * 'typo' → spelling; 'accent'/'article' pass through.
 */
function issueTypeToCategory(issueType: GradingIssueType): TypedErrorCategory | null {
  if (issueType === 'accent')  return 'accent'
  if (issueType === 'article') return 'article'
  if (issueType === 'typo')    return 'spelling'
  return null
}

/**
 * Applies per-pair strictness to a graded typed answer to decide the scheduling
 * penalty, the loggable category, and whether a retype is required.
 *
 * Contract: grade the answer in flexible mode with ignoreAccents / ignoreDefiniteArticles
 * / ignoreMinorTypos all FALSE, so every slip surfaces as an 'almost' with an issueType.
 * This function then decides the *consequence* based on the learner's per-pair toggles:
 *   - exact correct          → weight 0, no retype
 *   - accent/article slip     → strict: 0.2 penalty, lenient: 0 (green); always retype + log
 *   - spelling (typo) slip    → strict: 0.3 penalty, lenient: 0 (green); always retype + log
 *   - other 'almost' (parenthetical) → mild 0.2, retype, no log
 *   - incorrect / wrong word  → weight 1 (full "again"), retype, overridable
 */
export function resolveTypedPenalty(
  result:     GradingResult,
  strictness: TypedStrictness,
): TypedPenalty {
  if (result.status === 'correct') {
    return { weight: 0, category: null, accepted: true, requiresRetype: false }
  }

  if (result.status === 'almost') {
    const category = issueTypeToCategory(result.issueType)
    // Map a category + its level to (penalty weight, whether a retype is required):
    //   'penalize' → full category weight, retype required
    //   'retype'   → no penalty, retype required
    //   'accept'   → no penalty, no retype (marked correct with an "X error" note)
    const resolve = (level: TypedStrictnessLevel, weight: number): TypedPenalty => ({
      weight:         level === 'penalize' ? weight : 0,
      category,
      accepted:       true,
      requiresRetype: level !== 'accept',
    })
    if (category === 'accent')   return resolve(strictness.accents,  TYPED_PENALTY_WEIGHTS.accent)
    if (category === 'article')  return resolve(strictness.articles, TYPED_PENALTY_WEIGHTS.article)
    if (category === 'spelling') return resolve(strictness.spelling, TYPED_PENALTY_WEIGHTS.spelling)
    // Non-toggleable 'almost' (e.g. missing parenthetical): mild penalty, not logged.
    return { weight: TYPED_PENALTY_WEIGHTS.other, category: null, accepted: true, requiresRetype: true }
  }

  // status === 'incorrect' | 'missing' → full wrong.
  return { weight: 1, category: issueTypeToCategory(result.issueType), accepted: false, requiresRetype: true }
}

// ─── Severity scoring (for scheduler interval scaling) ─────────────────────────

/**
 * Returns a 0–1 severity score for a wrong typed answer.
 * Used to scale interval reduction in the long-term scheduler.
 * Only meaningful when gradeTyping() returned incorrect.
 */
export function classifyWrongAnswer(
  userAnswer: string,
  expected:   string,
  settings:   GradingSettings,
): number {
  const normalizedUser     = normalizeAnswer(userAnswer, settings)
  const normalizedExpected = normalizeAnswer(expected, settings)

  if (normalizedUser.length === 0) return 1.0

  const userNoArticle     = stripLeadingArticle(normalizedUser, settings.answerLanguage)
  const expectedNoArticle = stripLeadingArticle(normalizedExpected, settings.answerLanguage)
  if (userNoArticle === expectedNoArticle && normalizedUser !== normalizedExpected) {
    return 0.3
  }

  if (
    normalizedUser !== normalizedExpected &&
    stripAccents(normalizedUser) === stripAccents(normalizedExpected)
  ) {
    return 0.05
  }

  const distance = levenshtein(normalizedUser, normalizedExpected)
  const maxLen   = Math.max(normalizedUser.length, normalizedExpected.length, 1)
  const ratio    = distance / maxLen

  if (ratio <= 0.34) return 0.15
  if (ratio >= 0.75) return 1.0
  return 0.6
}

/**
 * True if the wrong typed answer represents a genuinely different word rather
 * than a typo/accent/article slip. Used for CardConfusion isWordMixup tracking.
 */
export function isDifferentWordMistake(
  userAnswer: string,
  expected:   string,
  settings:   GradingSettings,
): boolean {
  const normalizedUser = normalizeAnswer(userAnswer, settings)
  if (normalizedUser.length === 0) return false
  return classifyWrongAnswer(userAnswer, expected, settings) >= 1.0
}
