'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Card, Rung, Rating, GradingSettings } from '@/domain'
import { DEFAULT_GRADING_SETTINGS } from '@/domain'
import { gradeTyping, resolveTypedPenalty } from '@/engine/grading'
import type { RungAttemptOutcome } from '@/engine/ladderEngine'
import { displayText } from '@/lib/cardText'
import { speak, speakViaTts } from '@/lib/speak'
import { TTS_SUPPORTED_LANGUAGES } from '@/lib/languages'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { RatingButtons } from '@/components/session/RatingButtons'

// Which side is shown vs. produced, and the produced side's language.
function sides(card: Card, rung: Rung) {
  const produceNative = rung.direction === 'produce_native'
  return produceNative
    ? { prompt: displayText(card.front), promptLang: card.sourceLanguage, answer: card.back, answerLang: card.targetLanguage }
    : { prompt: displayText(card.back), promptLang: card.targetLanguage, answer: card.front, answerLang: card.sourceLanguage }
}

// Grade a typed answer under a strictness → a normalized outcome.
function gradeTyped(input: string, expected: string, answerLanguage: string, rung: Rung): 'pass' | 'almost' | 'miss' {
  const settings: GradingSettings = {
    ...DEFAULT_GRADING_SETTINGS, gradingMode: 'flexible',
    ignoreAccents: false, ignoreDefiniteArticles: false, ignoreMinorTypos: false, answerLanguage,
  }
  const res = gradeTyping(input, expected, settings)
  if (res.status === 'correct') return 'pass'
  if (res.status === 'almost') {
    const strictness = rung.strictness ?? { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }
    return resolveTypedPenalty(res, strictness).requiresRetype ? 'almost' : 'pass'
  }
  return 'miss'
}

function norm(s: string) { return displayText(s).trim().toLowerCase() }

/** Builds up to 4 shuffled MCQ options (the correct answer + distractors). */
function mcqOptions(card: Card, rung: Rung, deckCards: Card[]): string[] {
  const produceNative = rung.direction === 'produce_native'
  const correct = displayText(produceNative ? card.back : card.front)
  const pool: string[] = []
  if (rung.distractorSource === 'smart' && card.choices) {
    pool.push(...((produceNative ? card.choices.back : card.choices.front) ?? []).map(displayText))
  }
  // Deck fallback (also fills in if smart pool is short).
  for (const c of deckCards) {
    if (c.id === card.id) continue
    pool.push(displayText(produceNative ? c.back : c.front))
  }
  const seen = new Set([norm(correct)])
  const distractors: string[] = []
  for (const p of pool) {
    if (distractors.length >= 3) break
    if (seen.has(norm(p))) continue
    seen.add(norm(p)); distractors.push(p)
  }
  return [correct, ...distractors].sort(() => Math.random() - 0.5)
}

export function LadderExercise({ card, rung, deckCards, onOutcome, autoPlayAudio = true }: {
  card: Card
  rung: Rung
  deckCards: Card[]
  onOutcome: (o: RungAttemptOutcome) => void
  autoPlayAudio?: boolean
}) {
  const s = useMemo(() => sides(card, rung), [card, rung])
  const isDictation = rung.type === 'dictation'
  const [input, setInput] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [awaitingRating, setAwaitingRating] = useState(false)  // typed/mcq correct → self-rate
  const [feedback, setFeedback] = useState<'pass' | 'almost' | 'miss' | null>(null)
  const options = useMemo(() => rung.type === 'mcq' ? mcqOptions(card, rung, deckCards) : [], [card, rung, deckCards])
  const inputRef = useRef<HTMLInputElement>(null)
  const [audio, setAudio] = useState<string | null>(card.audioData ?? null)

  // Plays the target audio: cached if present, else generate on demand (ElevenLabs)
  // and cache it on the card; browser TTS as a last resort.
  async function playAudio() {
    if (audio) { speak(card.front, card.sourceLanguage, audio); return }
    if (TTS_SUPPORTED_LANGUAGES.has(card.sourceLanguage)) {
      const b64 = await speakViaTts(card.front, card.sourceLanguage)
      if (b64) {
        setAudio(b64)
        new SupabaseCardRepository().update(card.id, { audioGenerated: true, audioData: b64 }).catch(() => {})
        return
      }
    }
    speak(card.front, card.sourceLanguage, null)
  }

  // Dictation always plays the target audio on mount.
  useEffect(() => {
    if (isDictation && autoPlayAudio) playAudio()
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [card.id, rung.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Self-graded: reveal then rate ──
  if (rung.type === 'self_graded') {
    return (
      <div className="space-y-4">
        <Prompt text={isDictation ? '🔊' : s.prompt} sub="Recall the answer" />
        {!revealed ? (
          <button className="btn-primary w-full" onClick={() => setRevealed(true)}>Reveal answer</button>
        ) : (
          <>
            <div className="panel text-center font-mono text-lg text-ink">{displayText(s.answer)}</div>
            <RatingButtons onRate={r => onOutcome(r)} suggestedRating="good" />
          </>
        )}
      </div>
    )
  }

  // ── Multiple choice ──
  if (rung.type === 'mcq') {
    function pick(opt: string) {
      const correct = norm(opt) === norm(s.answer)
      if (!rung.selfRated) { onOutcome(correct ? 'pass' : 'miss'); return }
      if (correct) { setAwaitingRating(true); setFeedback('pass') }
      else onOutcome('again')   // wrong on a self-rated rung = auto-Again
    }
    return (
      <div className="space-y-4">
        <Prompt text={s.prompt} sub="Choose the answer" />
        {awaitingRating ? (
          <>
            <div className="panel text-center text-success font-mono">{displayText(s.answer)}</div>
            <RatingButtons onRate={r => onOutcome(r)} suggestedRating="good" />
          </>
        ) : (
          <div className="grid gap-2">
            {options.map((o, i) => (
              <button key={i} onClick={() => pick(o)} className="panel py-3 font-mono text-ink hover:border-accent/50 text-center">{o}</button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Typing / Dictation ──
  function check() {
    const outcome = gradeTyped(input, s.answer, s.answerLang, rung)
    setFeedback(outcome)
    if (!rung.selfRated) { onOutcome(outcome); return }
    if (outcome === 'pass') setAwaitingRating(true)
    else onOutcome('again')  // wrong/almost on a self-rated rung = auto-Again
  }
  return (
    <div className="space-y-4">
      <Prompt text={isDictation ? '🔊 Type what you hear' : s.prompt} sub={isDictation ? 'Dictation (target language)' : 'Type the answer'} />
      {isDictation && (
        <button className="btn-ghost text-sm" onClick={() => playAudio()}>▶ Play again</button>
      )}
      {awaitingRating ? (
        <>
          <div className="panel text-center text-success font-mono">{displayText(s.answer)}</div>
          <RatingButtons onRate={r => onOutcome(r)} suggestedRating="good" />
        </>
      ) : (
        <>
          <input ref={inputRef} className="input text-center text-lg font-mono" value={input}
            placeholder="Type your answer…" onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && input.trim()) check() }} />
          {feedback && feedback !== 'pass' && (
            <p className="text-sm text-center text-ink-muted">Answer: <span className="font-mono text-ink">{displayText(s.answer)}</span></p>
          )}
          <button className="btn-primary w-full" disabled={!input.trim()} onClick={check}>Check</button>
        </>
      )}
    </div>
  )
}

function Prompt({ text, sub }: { text: string; sub: string }) {
  return (
    <div className="panel text-center py-8 space-y-1">
      <p className="text-2xl font-semibold text-ink">{text}</p>
      <p className="text-xs text-ink-faint uppercase tracking-wider">{sub}</p>
    </div>
  )
}
