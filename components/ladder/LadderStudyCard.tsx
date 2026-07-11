'use client'

import { useEffect, useRef, useState } from 'react'
import type { Card, Rung, GradingSettings, CardChoices, CardSide } from '@/domain'
import { DEFAULT_TYPED_STRICTNESS } from '@/domain'
import type { RungAttemptOutcome } from '@/engine/ladderEngine'
import { mcqOutcome, typedOutcome, producesNative } from '@/lib/ladderSession'
import { gradeTyping, resolveTypedPenalty } from '@/engine/grading'
import { MultipleChoiceMode } from '@/components/session/MultipleChoiceMode'
import { TypingMode } from '@/components/session/TypingMode'
import { FlashcardMode } from '@/components/session/FlashcardMode'
import { speak, speakViaTts, stripAnnotations } from '@/lib/speak'
import { TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { RatingButtons } from '@/components/session/RatingButtons'
import { displayText } from '@/lib/cardText'

/**
 * Renders one ladder rung using the EXISTING study screens (Multiple choice,
 * Typing, Flashcard) so the ladder looks and behaves like normal study. Dictation
 * is a small custom screen (no existing equivalent). Each screen's result is
 * mapped to a single ladder outcome via `onOutcome`.
 */
export function LadderStudyCard({ card, rung, deckCards, deckName, sourceLanguage, targetLanguage, gradingSettings, overrides, onOverrideAnswer, onOutcome, onChoicesCached, onInfo }: {
  card:           Card
  rung:           Rung
  deckCards:      Card[]
  deckName?:      string
  sourceLanguage: string
  targetLanguage: string
  gradingSettings: GradingSettings
  overrides?:      Map<string, Set<string>>
  onOverrideAnswer?: (cardId: string, answerSide: CardSide, answerText: string, accept: boolean) => void
  onOutcome:      (o: RungAttemptOutcome) => void
  onChoicesCached?: (cardId: string, choices: CardChoices) => void
  onInfo?:        () => void
}) {
  const native = producesNative(rung)
  const promptSide = native ? 'front' : 'back'   // produce native → show the target word; produce target → show the native gloss
  const answerSide = native ? 'back' : 'front'
  const [showIpa, setShowIpa] = useState(false)
  // Shared "corner button" wiring: ? (give up → a miss/again), IPA toggle, and info.
  const missOutcome: RungAttemptOutcome = rung.selfRated ? 'again' : 'miss'
  const ipaProps = { ipaText: showIpa ? (card.ipa ?? undefined) : undefined, onToggleIPA: () => setShowIpa(v => !v) }

  if (rung.type === 'mcq') {
    return (
      <MultipleChoiceMode
        key={`${card.id}-${rung.id}`}
        card={card} promptSide={promptSide} answerSide={answerSide}
        deckCards={deckCards} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage} deckName={deckName}
        onChoicesCached={onChoicesCached} onInfo={onInfo}
        onIDontKnow={() => {}} onAdvance={() => onOutcome(missOutcome)} {...ipaProps}
        onRate={(r, wasCorrect) => onOutcome(mcqOutcome(wasCorrect, rung.selfRated, r))}
      />
    )
  }

  if (rung.type === 'self_graded') {
    return (
      <FlashcardMode
        key={`${card.id}-${rung.id}`}
        card={card} promptSide={promptSide} deckName={deckName} onInfo={onInfo}
        answerLanguage={answerSide === 'front' ? sourceLanguage : targetLanguage}
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
        strictness={rung.strictness ?? DEFAULT_TYPED_STRICTNESS} deckName={deckName} onInfo={onInfo}
        overrideAnswers={Array.from(overrides?.get(`${card.id}:${answerSide}`) ?? [])}
        onOverrideAnswer={(answerText, accept) => onOverrideAnswer?.(card.id, answerSide, answerText, accept)}
        synonyms={answerSide === 'front' ? (card.choices?.frontSynonyms ?? []) : (card.choices?.backSynonyms ?? [])}
        onIDontKnow={() => {}} onAdvance={() => onOutcome(missOutcome)} {...ipaProps}
        onRate={(r, wasCorrect) => onOutcome(typedOutcome(wasCorrect ? 'pass' : 'miss', rung.selfRated, r))}
      />
    )
  }

  // Dictation — custom (no existing screen): play target audio, type it.
  return <Dictation card={card} rung={rung} deckName={deckName} onOutcome={onOutcome} onInfo={onInfo}
    overrideAnswers={Array.from(overrides?.get(`${card.id}:front`) ?? [])}
    onOverrideAnswer={(answerText, accept) => onOverrideAnswer?.(card.id, 'front', answerText, accept)} />
}

function DictationInfoButton({ onInfo }: { onInfo?: () => void }) {
  if (!onInfo) return null
  return (
    <button onClick={onInfo} title="Card info" className="absolute top-3 right-3 w-5 h-5 flex items-center justify-center rounded-full border border-white/10 text-ink-faint hover:text-ink-muted text-xs italic">i</button>
  )
}

function Dictation({ card, rung, deckName, onOutcome, onInfo, overrideAnswers, onOverrideAnswer }: { card: Card; rung: Rung; deckName?: string; onOutcome: (o: RungAttemptOutcome) => void; onInfo?: () => void; overrideAnswers?: string[]; onOverrideAnswer?: (answerText: string, accept: boolean) => void }) {
  const [input, setInput] = useState('')
  const [rating, setRating] = useState(false)
  const [result, setResult] = useState<{ status: 'pass' | 'almost' | 'miss'; overridden: boolean; normalized: string } | null>(null)
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
  useEffect(() => { setInput(''); setResult(null); setRating(false); play(); setTimeout(() => inputRef.current?.focus(), 60) }, [card.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function check() {
    const settings: GradingSettings = { gradingMode: 'flexible', ignoreAccents: false, ignoreCapitalization: true, ignoreMinorTypos: false, ignoreDefiniteArticles: false, requireParentheticalContent: false, slashAlternativesMode: 'accept_any', commaAlternativesMode: 'split_into_cards', autoPlayAudio: false, answerLanguage: card.sourceLanguage }
    // Grade against the word without its "(f)"/"(m)" annotation — you only type what you hear.
    const res = gradeTyping(input, stripAnnotations(card.front), settings)
    let status: 'pass' | 'almost' | 'miss' = res.status === 'correct' ? 'pass'
      : res.status === 'almost' ? (resolveTypedPenalty(res, rung.strictness ?? DEFAULT_TYPED_STRICTNESS).requiresRetype ? 'almost' : 'pass') : 'miss'
    // Honour a persisted override for this exact typed answer (marked OK before).
    const viaOverride = status !== 'pass' && !!res.normalizedUser && (overrideAnswers ?? []).includes(res.normalizedUser)
    if (viaOverride) status = 'pass'
    setResult({ status, overridden: viaOverride, normalized: res.normalizedUser })
    // Focus Continue after the result renders (delayed so the Enter that triggered
    // this check doesn't immediately fire the newly-focused button).
    setTimeout(() => continueRef.current?.focus(), 100)
  }

  // Advance with the confirmed outcome (Continue). Self-rated rungs still self-rate on a pass.
  function proceed() {
    if (!result) return
    const finalStatus: 'pass' | 'almost' | 'miss' = result.overridden ? 'pass' : result.status
    if (rung.selfRated && finalStatus === 'pass') { setRating(true); setResult(null); return }
    onOutcome(typedOutcome(finalStatus, rung.selfRated))
  }

  const isCorrect = result != null && (result.overridden || result.status === 'pass')

  return (
    <div className="space-y-6 w-full max-w-xl mx-auto">
      {deckName && <p className="text-xs text-ink-faint text-center uppercase tracking-wider">{deckName}</p>}
      <div className="panel relative min-h-[120px] flex flex-col items-center justify-center text-center gap-3">
        <DictationInfoButton onInfo={onInfo} />
        <button onClick={play} className="text-ink-muted hover:text-ink" title="Play again">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10">
            <path d="M13.5 4.06c0-1.336-1.616-2.005-2.56-1.06l-4.5 4.5H4.508c-1.141 0-2.318.664-2.66 1.905A9.76 9.76 0 0 0 1.5 12c0 .898.121 1.768.35 2.595.341 1.24 1.518 1.905 2.659 1.905h1.93l4.5 4.5c.945.945 2.561.276 2.561-1.06V4.06ZM18.584 5.106a.75.75 0 0 1 1.06 0c3.808 3.807 3.808 9.98 0 13.788a.75.75 0 0 1-1.06-1.06 8.25 8.25 0 0 0 0-11.668.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
        <p className="text-xs text-ink-faint uppercase tracking-wider">Dictation — type what you hear</p>
      </div>
      {rating ? (
        <>
          <div className="panel text-center font-mono text-lg text-success">{displayText(card.front)}</div>
          <p className="text-center text-sm text-ink-muted">{card.back}</p>
          <RatingButtons onRate={r => onOutcome(r)} suggestedRating="good" />
        </>
      ) : result ? (
        <>
          <div className={`panel text-center font-mono text-lg ${isCorrect ? 'text-success' : 'text-danger'}`}>{displayText(card.front)}</div>
          <p className="text-center text-sm text-ink-muted">{card.back}</p>
          {!isCorrect && (
            <p className="text-center text-sm text-ink-muted">You typed: <span className="font-mono text-ink">{input || '—'}</span></p>
          )}
          <div className="flex flex-col items-center gap-2">
            <button ref={continueRef} className="btn-primary px-10" onClick={proceed}>Continue</button>
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
          <input ref={inputRef} className="input text-center text-lg font-mono" value={input} placeholder="Type what you hear…"
            onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && input.trim()) check() }} />
          <div className="flex justify-center"><button className="btn-primary px-10" disabled={!input.trim()} onClick={check}>Check</button></div>
          <button onClick={() => onOutcome(rung.selfRated ? 'again' : 'miss')} className="block mx-auto text-sm text-danger/70 hover:text-danger">Don&apos;t know</button>
        </>
      )}
    </div>
  )
}
