'use client'

import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '@/lib/apiBase'
import type { Card, Rung, GradingSettings, CardChoices, CardSide, ErrorType } from '@/domain'
import { DEFAULT_TYPED_STRICTNESS } from '@/domain'
import type { RungAttemptOutcome } from '@/engine/ladderEngine'
import { mcqOutcome, typedOutcome, producesNative } from '@/lib/ladderSession'
import { issueToErrorTypes } from '@/lib/pathway'
import { gradeTyping, resolveTypedPenalty } from '@/engine/grading'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { TypingMode } from '@/components/session/TypingMode'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { speak, speakViaTts, stripAnnotations } from '@/lib/speak'
import { langName, langNativeName, TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { RatingButtons } from '@/components/session/RatingButtons'
import { displayText } from '@/lib/cardText'

/**
 * Renders one ladder rung using the EXISTING study screens (Multiple choice,
 * Typing, Flashcard) so the ladder looks and behaves like normal study. Dictation
 * is a small custom screen (no existing equivalent). Each screen's result is
 * mapped to a single ladder outcome via `onOutcome`.
 */
export function LadderStudyCard({ card, rung, deckCards, deckName, sourceLanguage, targetLanguage, gradingSettings, overrides, onOverrideAnswer, onChoiceEdit, onCardEdit, onRepeat, onOutcome, onChoicesCached, onInfo, ipaOn, onToggleIpa, onIpaFetched }: {
  card:           Card
  rung:           Rung
  deckCards:      Card[]
  deckName?:      string
  sourceLanguage: string
  targetLanguage: string
  gradingSettings: GradingSettings
  overrides?:      Map<string, Set<string>>
  onOverrideAnswer?: (cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => void
  onChoiceEdit?:   (cardId: string, answerSide: CardSide, originalChoice: string, newText: string, isCorrect: boolean) => Promise<void>
  /** Inline edit of the card's prompt/answer text (empty string = delete the card). */
  onCardEdit?:     (cardId: string, side: CardSide, newText: string) => void
  onRepeat?:       () => void
  /** `errorTypes` (typed/dictation only) drives pathway error-branch transitions; ladders ignore it. */
  onOutcome:      (o: RungAttemptOutcome, overridden?: boolean, almost?: boolean, errorTypes?: ErrorType[]) => void
  onChoicesCached?: (cardId: string, choices: CardChoices) => void
  onInfo?:        () => void
  /** Session-sticky "show IPA" flag: once on, every card shows IPA until turned off. */
  ipaOn?:         boolean
  onToggleIpa?:   () => void
  /** Report a freshly-transcribed IPA up so the parent can cache it on the card. */
  onIpaFetched?:  (cardId: string, ipa: string) => void
}) {
  const native = producesNative(rung)
  const promptSide = native ? 'front' : 'back'   // produce native → show the target word; produce target → show the native gloss
  const answerSide = native ? 'back' : 'front'
  const showIpa = !!ipaOn   // controlled by the session-level flag, so it sticks across cards
  const [fetchedIpa, setFetchedIpa] = useState<string | null>(null)
  // Fetch (and persist) IPA on demand when IPA is on and this card has none — mirrors the session pages,
  // so it works even for cards that were never transcribed.
  useEffect(() => {
    if (!showIpa || card.ipa || fetchedIpa) return
    let cancelled = false
    fetch(apiUrl('/api/ipa'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: card.front, language: sourceLanguage }),
    })
      .then(r => r.json())
      .then((d: { ok: boolean; ipa?: string }) => {
        if (cancelled || !d.ok || !d.ipa) return
        setFetchedIpa(d.ipa)
        onIpaFetched?.(card.id, d.ipa)
        new SupabaseCardRepository().update(card.id, { ipa: d.ipa }).catch(() => {})
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [showIpa, card.id, card.ipa, card.front, sourceLanguage, fetchedIpa, onIpaFetched])
  // Shared "corner button" wiring: ? (give up → a miss/again), IPA toggle, and info.
  const missOutcome: RungAttemptOutcome = rung.selfRated ? 'again' : 'miss'
  const effectiveIpa = card.ipa ?? fetchedIpa
  const ipaProps = { ipaText: showIpa ? (effectiveIpa ?? undefined) : undefined, onToggleIPA: () => onToggleIpa?.() }

  // Track whether this attempt was marked correct via override (accept=true), so the replay can
  // flash the overridden result rather than the natural grade. Resets each card (component remounts).
  const overrodeRef = useRef(false)
  const almostRef = useRef(false)   // near-miss on the current attempt (for 'almost' outcome/color)
  const trackOverride = (answerSide: CardSide) => (answerText: string, accept: boolean) => {
    if (accept) overrodeRef.current = true
    onOverrideAnswer?.(card.id, answerSide, answerText, accept)
  }

  if (rung.type === 'mcq') {
    return (
      <MultipleChoiceMode
        key={`${card.id}-${rung.id}`}
        card={card} promptSide={promptSide} answerSide={answerSide}
        deckCards={deckCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage} deckName={deckName}
        autoPlayAudio={gradingSettings.autoPlayAudio ?? true}
        onChoicesCached={onChoicesCached} onInfo={onInfo}
        overrideAnswers={Array.from(overrides?.get(`${card.id}:${answerSide}`) ?? [])}
        onOverrideAnswer={trackOverride(answerSide)}
        onChoiceEdit={onChoiceEdit ? ((orig, newText, isCorrect) => onChoiceEdit(card.id, answerSide, orig, newText, isCorrect)) : undefined}
        onPromptEdit={onCardEdit ? (t => onCardEdit(card.id, promptSide, t)) : undefined}
        onRepeat={onRepeat}
        onIDontKnow={() => {}} onAdvance={() => onOutcome(missOutcome)} {...ipaProps}
        onRate={(r, wasCorrect) => onOutcome(mcqOutcome(wasCorrect, rung.selfRated, r), overrodeRef.current)}
      />
    )
  }

  if (rung.type === 'self_graded') {
    return (
      <FlashcardMode
        key={`${card.id}-${rung.id}`}
        card={card} promptSide={promptSide} deckName={deckName} onInfo={onInfo}
        promptLanguage={promptSide === 'front' ? sourceLanguage : undefined}
        answerLanguage={answerSide === 'front' ? sourceLanguage : targetLanguage}
        autoPlayAudio={gradingSettings.autoPlayAudio ?? true}
        onPromptEdit={onCardEdit ? (t => onCardEdit(card.id, promptSide, t)) : undefined}
        onAnswerEdit={onCardEdit ? (t => onCardEdit(card.id, answerSide, t)) : undefined}
        {...ipaProps}
        onRate={r => onOutcome(r)}
      />
    )
  }

  if (rung.type === 'typing') {
    return (
      <TypingMode
        key={`${card.id}-${rung.id}`}
        card={card} promptSide={promptSide}
        promptLanguage={promptSide === 'front' ? sourceLanguage : undefined}
        answerLanguage={answerSide === 'front' ? sourceLanguage : targetLanguage}
        gradingSettings={gradingSettings} gradedReview={rung.selfRated}
        autoPlayAudio={gradingSettings.autoPlayAudio ?? true}
        strictness={rung.strictness ?? DEFAULT_TYPED_STRICTNESS} deckName={deckName} onInfo={onInfo}
        overrideAnswers={Array.from(overrides?.get(`${card.id}:${answerSide}`) ?? [])}
        onOverrideAnswer={trackOverride(answerSide)}
        onPromptEdit={onCardEdit ? (t => onCardEdit(card.id, promptSide, t)) : undefined}
        onAnswerEdit={onCardEdit ? (t => onCardEdit(card.id, answerSide, t)) : undefined}
        synonyms={answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
        onAddSynonym={answerSide === 'front' ? (normalizedText => {
          // Accept this typed answer as a synonym: persist it onto the card and update local state so
          // it's accepted immediately (and next time). Repo is offline-guarded, so this works offline.
          const existing: CardChoices = card.choices ?? { front: [], back: [] }
          const next: CardChoices = { ...existing, frontSynonyms: [...(existing.frontSynonyms ?? []), normalizedText] }
          onChoicesCached?.(card.id, next)
          void new SupabaseCardRepository().update(card.id, { choices: next }).catch(() => {})
        }) : undefined}
        onRepeat={onRepeat}
        onNearMiss={isAlmost => { almostRef.current = isAlmost }}
        onIDontKnow={() => {}} onAdvance={() => onOutcome(missOutcome)} {...ipaProps}
        onRate={(r, wasCorrect, _ua, issueType) => onOutcome(typedOutcome(wasCorrect ? 'pass' : 'miss', rung.selfRated, r), overrodeRef.current, almostRef.current, issueToErrorTypes(issueType ?? 'none'))}
      />
    )
  }

  // Dictation — custom (no existing screen): play the TARGET audio; type either the target (what you
  // hear) or the native (its translation), per the rung's direction.
  return <Dictation card={card} rung={rung} deckName={deckName} onOutcome={onOutcome} onInfo={onInfo}
    overrideAnswers={Array.from(overrides?.get(`${card.id}:${answerSide}`) ?? [])}
    onOverrideAnswer={(answerText, accept) => onOverrideAnswer?.(card.id, answerSide, answerText, accept)} />
}

function DictationInfoButton({ onInfo }: { onInfo?: () => void }) {
  if (!onInfo) return null
  return (
    <button onClick={onInfo} title="Card info" className="absolute top-3 right-3 w-5 h-5 flex items-center justify-center rounded-full border border-line/10 text-ink-faint hover:text-ink-muted text-xs italic">i</button>
  )
}

function Dictation({ card, rung, deckName, onOutcome, onInfo, overrideAnswers, onOverrideAnswer }: { card: Card; rung: Rung; deckName?: string; onOutcome: (o: RungAttemptOutcome, overridden?: boolean, almost?: boolean, errorTypes?: ErrorType[]) => void; onInfo?: () => void; overrideAnswers?: string[]; onOverrideAnswer?: (answerText: string, accept: boolean) => void }) {
  // You always HEAR the target word (card.front). Producing the target = type what you hear; producing
  // the native = type its translation (card.back). Audio is unchanged; only the graded side differs.
  const native = producesNative(rung)
  const answerText = native ? card.back : card.front
  const answerLang = native ? card.targetLanguage : card.sourceLanguage
  const [input, setInput] = useState('')
  const [result, setResult] = useState<{ status: 'pass' | 'almost' | 'miss'; overridden: boolean; normalized: string; errorTypes: ErrorType[] } | null>(null)
  // Set when a "type the translation" prompt was answered with the word you just HEARD. That's not a
  // wrong answer — you understood the audio, you just produced the wrong side — so instead of marking
  // it a miss we accept it and re-ask for the translation. Only fires once per card, so answering with
  // the target word a second time is graded normally rather than looping forever.
  const [echoed, setEchoed] = useState(false)
  const [audio, setAudio] = useState<string | null>(card.audioData ?? null)
  const inputRef = useRef<HTMLInputElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)

  async function play() {
    // Respect the card's chosen audio source. 'browser' (Robotic) → on-device speech,
    // never fetch. Otherwise play the active clip (audioData), or fetch it if missing.
    if (card.audioSource === 'browser') { speak(card.front, card.sourceLanguage, null); return }
    if (audio) { speak(card.front, card.sourceLanguage, audio); return }
    if (TTS_SUPPORTED_LANGUAGES.has(card.sourceLanguage)) {
      const b64 = await speakViaTts(card.front, card.sourceLanguage)
      if (b64) { setAudio(b64); new SupabaseCardRepository().update(card.id, { audioGenerated: true, audioData: b64 }).catch(() => {}); return }
    }
    speak(card.front, card.sourceLanguage, null)
  }
  // Reset per card, replay audio, focus the input.
  useEffect(() => { setInput(''); setResult(null); setEchoed(false); play(); setTimeout(() => inputRef.current?.focus(), 60) }, [card.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function check() {
    const settings: GradingSettings = { gradingMode: 'flexible', ignoreAccents: false, ignoreCapitalization: true, ignoreMinorTypos: false, ignoreDefiniteArticles: false, requireParentheticalContent: false, slashAlternativesMode: 'accept_any', commaAlternativesMode: 'split_into_cards', autoPlayAudio: false, answerLanguage: answerLang }
    // Grade against the answer side without its "(f)"/"(m)" annotation.
    const res = gradeTyping(input, stripAnnotations(answerText), settings)

    // "Type the translation" answered with the word you just heard → transcription, not translation.
    // Accept it and re-ask for the native side rather than scoring a miss.
    if (native && !echoed && res.status !== 'correct' && res.status !== 'almost') {
      const heard = gradeTyping(input, stripAnnotations(card.front), { ...settings, answerLanguage: card.sourceLanguage })
      if (heard.status === 'correct' || heard.status === 'almost') {
        setEchoed(true); setInput('')
        setTimeout(() => inputRef.current?.focus(), 60)
        return
      }
    }
    let status: 'pass' | 'almost' | 'miss' = res.status === 'correct' ? 'pass'
      : res.status === 'almost' ? (resolveTypedPenalty(res, rung.strictness ?? DEFAULT_TYPED_STRICTNESS).requiresRetype ? 'almost' : 'pass') : 'miss'
    // Honour a persisted override for this exact typed answer (marked OK before).
    const viaOverride = status !== 'pass' && !!res.normalizedUser && (overrideAnswers ?? []).includes(res.normalizedUser)
    if (viaOverride) status = 'pass'
    setResult({ status, overridden: viaOverride, normalized: res.normalizedUser, errorTypes: issueToErrorTypes(res.issueType) })
    // Focus Continue after the result renders (delayed so the Enter that triggered
    // this check doesn't immediately fire the newly-focused button).
    setTimeout(() => continueRef.current?.focus(), 100)
  }

  // Advance with the confirmed outcome (Continue). On a self-rated rung a correct answer skips this
  // entirely — the rating buttons are shown straight away and picking one IS the advance.
  function proceed() {
    if (!result) return
    const finalStatus: 'pass' | 'almost' | 'miss' = result.overridden ? 'pass' : result.status
    onOutcome(typedOutcome(finalStatus, rung.selfRated), result.overridden, result.status === 'almost', result.errorTypes)
  }

  const isCorrect = result != null && (result.overridden || result.status === 'pass')
  // Rate-to-advance: no Continue step, since choosing Again/Hard/Good/Easy already says "move on".
  // A wrong answer still gets Continue — there's a correct answer to read, and nothing to self-rate.
  const rateToAdvance = rung.selfRated && isCorrect

  return (
    <div className="space-y-6 w-full max-w-[730px] mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel relative min-h-[120px] flex flex-col items-center justify-center text-center gap-3">
        <DictationInfoButton onInfo={onInfo} />
        <button onClick={play} className="text-ink-muted hover:text-ink" title="Play again">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10">
            <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
        <p className="text-xs text-ink-faint uppercase tracking-wider">{native ? 'Dictation — type the translation' : 'Dictation — type what you hear'}</p>
      </div>
      {result ? (
        <>
          {/* Correct → show the answer (green). Wrong → show what the LEARNER typed (red), with the
              correct answer spelled out below. */}
          <div className={`panel text-center font-mono text-lg ${isCorrect ? 'text-success' : 'text-danger'}`}>{isCorrect ? displayText(answerText) : (input || '—')}</div>
          <p className="text-center text-sm text-ink-muted">{native ? displayText(card.front) : card.back}</p>
          {!isCorrect && (
            <p className="text-center text-sm text-ink-muted">Correct answer: <span className="font-mono text-ink">{displayText(answerText)}</span></p>
          )}
          <div className="flex flex-col items-center gap-2">
            {rateToAdvance ? (
              <RatingButtons onRate={r => onOutcome(r, result.overridden, false, result.errorTypes)} suggestedRating="good" />
            ) : (
              <button ref={continueRef} className="btn-primary px-10" onClick={proceed}>Continue</button>
            )}
            {!isCorrect && (
              <button
                onClick={() => { setResult(r => r ? { ...r, overridden: true } : r); if (result?.normalized) onOverrideAnswer?.(result.normalized, true) }}
                className="text-sm text-ink-muted hover:text-ink"
              >Override as correct</button>
            )}
          </div>
        </>
      ) : (
        <>
          {echoed && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-center space-y-0.5">
              <p className="text-sm text-ink">
                That&apos;s the word you heard — <span className="font-mono">{displayText(card.front)}</span> ✓
              </p>
              <p className="text-xs text-ink-muted">
                Now type its {langName(card.targetLanguage)} translation.
              </p>
            </div>
          )}
          <input ref={inputRef} className="input text-center text-lg font-mono" value={input}
            // Placeholder is just the expected answer language (e.g. "English" / "Italiano"). answerLang
            // = card.targetLanguage when typing the translation (incl. the echoed re-prompt, which is
            // always native), card.sourceLanguage when transcribing what you heard.
            placeholder={langNativeName(answerLang)}
            onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && input.trim()) check() }} />
          <div className="flex justify-center"><button className="btn-primary px-10" disabled={!input.trim()} onClick={check}>Check</button></div>
          <button
            onClick={() => { setResult({ status: 'miss', overridden: false, normalized: '', errorTypes: [] }); setTimeout(() => continueRef.current?.focus(), 100) }}
            className="block mx-auto text-sm text-danger/70 hover:text-danger"
          >Don&apos;t know</button>
        </>
      )}
    </div>
  )
}
