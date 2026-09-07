'use client'

/**
 * components/practice/MatchingGame.tsx — pair the target-language word with its native meaning.
 *
 * Like every practice exercise, deliberately NOT a study session: it writes nothing — no
 * card_states, no review events, no due dates. It also needs no generation, so it starts instantly.
 *
 * The session's words play in ROUNDS of up to eight pairs — rounds are why the word count is
 * unlimited: any selection is just more boards. Both columns shuffle independently, so a pair is
 * never straight across from itself.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Rating } from '@/domain'
import { AudioToggle, usePracticeAudio } from './usePracticeAudio'

export interface MatchPair {
  id:    string
  /** Target-language side (the word being learned). */
  front: string
  /** Native side (the meaning). */
  back:  string
}

const ROUND_SIZE = 8

const shuffle = <T,>(xs: T[]): T[] => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

interface Round {
  pairs: MatchPair[]
  left:  MatchPair[]   // front tiles, shuffled
  right: MatchPair[]   // back tiles, shuffled independently
}

function buildRounds(pairs: MatchPair[]): Round[] {
  const shuffled = shuffle(pairs)
  const rounds: Round[] = []
  for (let i = 0; i < shuffled.length; i += ROUND_SIZE) {
    const chunk = shuffled.slice(i, i + ROUND_SIZE)
    rounds.push({ pairs: chunk, left: shuffle(chunk), right: shuffle(chunk) })
  }
  return rounds
}

const fmtTime = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface MatchAttempt {
  /** The TARGET-side pair the learner picked. */
  pair: MatchPair
  correct: boolean
  /** On a mismatch: the pair whose native tile they wrongly chose. */
  confused?: MatchPair
}

export function MatchingGame({ pairs, onExit, targetSide = 'left', onSpeakTarget, onAttempt, renderFinish, shouldCollectRating, onRateMatch }: {
  pairs:  MatchPair[]
  onExit: () => void
  /** Which column holds the target-language words. */
  targetSide?: 'left' | 'right'
  /** Plays a word's audio; called on every tap of a target-language tile while audio is on. */
  onSpeakTarget?: (pair: MatchPair) => void
  /** Fire-and-forget attempt log — right or wrong, and wrong WITH WHAT. */
  onAttempt?: (a: MatchAttempt) => void
  /**
   * Replaces the default result screen (which says nothing was scheduled — true for practice,
   * wrong for express review, where a clean match IS a review). Also suppresses "Play again":
   * a replayed board would re-test cards that were just credited.
   */
  renderFinish?: (stats: { total: number; mistakes: number; elapsedMs: number }) => ReactNode
  /**
   * Express-with-ratings hook: called on a CORRECT match; return true to show Again/Hard/Good/Easy
   * over the tile that completed the pair. Ratings are NON-BLOCKING — the learner keeps matching
   * and rates whenever (or never). Passing this prop also changes how rounds end: they never
   * advance automatically; a Continue/Finish button appears once the round is fully matched, and
   * pressing it auto-rates that round's unrated matches as GOOD (via `onRateMatch`) before moving
   * on — so a rating can't be lost to a round flip, and the last round can't end without consent.
   */
  shouldCollectRating?: (pair: MatchPair) => boolean
  /** The rating chosen for a pair — tapped on its tile, or 'good' applied by the Continue button. */
  onRateMatch?: (pair: MatchPair, rating: Rating) => void
}) {
  const [audioOn, toggleAudio] = usePracticeAudio()
  const [rounds,   setRounds]   = useState<Round[]>(() => buildRounds(pairs))
  const [round,    setRound]    = useState(0)
  const [matched,  setMatched]  = useState<Set<string>>(new Set())   // pair ids, across all rounds
  const [selLeft,  setSelLeft]  = useState<string | null>(null)
  const [selRight, setSelRight] = useState<string | null>(null)
  /** Pair ids briefly painted red after a mismatch; cleared by a timeout. */
  const [wrong,    setWrong]    = useState<{ left: string; right: string } | null>(null)
  const [mistakes, setMistakes] = useState(0)
  /** Matched pairs awaiting a rating (pair id → the tile side carrying the overlay). */
  const [unrated, setUnrated] = useState<Map<string, 'left' | 'right'>>(new Map())
  const [elapsed,  setElapsed]  = useState(0)
  const [finished, setFinished] = useState(false)
  const startRef = useRef(Date.now())
  const wrongTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const current = rounds[round]
  const total   = pairs.length

  // A live clock makes it a game; frozen once done so the result screen shows the real time.
  useEffect(() => {
    if (finished) return
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 1000)
    return () => clearInterval(t)
  }, [finished])

  useEffect(() => () => { if (wrongTimer.current) clearTimeout(wrongTimer.current) }, [])

  const pairById = (id: string) => rounds.flatMap(r => r.pairs).find(p => p.id === id)

  /** Ends the round / game once every pair of the current round is in `nextMatched`. */
  function advanceIfRoundDone(nextMatched: Set<string>) {
    if (!current!.pairs.every(p => nextMatched.has(p.id))) return
    if (round + 1 < rounds.length) {
      setRound(r => r + 1)
    } else {
      setElapsed(Date.now() - startRef.current)
      setFinished(true)
    }
  }

  /** Rating mode = the express due-now game; the classic game passes no rating hook. */
  const ratingMode = !!shouldCollectRating

  /** A rating tapped on a tile's overlay. The round still advances only via the Continue button. */
  function rateTile(pairId: string, rating: Rating) {
    const tp = pairById(pairId)
    setUnrated(prev => { const next = new Map(prev); next.delete(pairId); return next })
    if (tp) onRateMatch?.(tp, rating)
  }

  /** The Continue/Finish button: everything still unrated in this round becomes a Good. */
  function continueRound() {
    unrated.forEach((_side, pairId) => {
      const tp = pairById(pairId)
      if (tp) onRateMatch?.(tp, 'good')
    })
    setUnrated(new Map())
    advanceIfRoundDone(matched)
  }

  /** Both sides picked → judge. Matching is by pair id, so duplicate glosses can't cross-match.
   *  `completedSide` = the column of the tap that completed the pair (where a rating overlay goes). */
  function judge(leftId: string, rightId: string, completedSide: 'left' | 'right') {
    const targetId = targetSide === 'left' ? leftId : rightId
    const otherId  = targetSide === 'left' ? rightId : leftId
    const tp = pairById(targetId)
    if (tp) onAttempt?.(leftId === rightId
      ? { pair: tp, correct: true }
      : { pair: tp, correct: false, confused: pairById(otherId) })
    if (leftId === rightId) {
      const nextMatched = new Set(matched).add(leftId)
      setMatched(nextMatched)
      setSelLeft(null); setSelRight(null)
      if (ratingMode) {
        // Never auto-advance in rating mode — even a no-overlay match (a previously fumbled pair)
        // completing the round must leave the Continue button in charge, or the round would flip
        // out from under still-unrated overlays.
        if (tp && shouldCollectRating!(tp)) {
          setUnrated(prev => new Map(prev).set(leftId, completedSide))
        }
        return
      }
      advanceIfRoundDone(nextMatched)
    } else {
      setMistakes(m => m + 1)
      setWrong({ left: leftId, right: rightId })
      setSelLeft(null); setSelRight(null)
      if (wrongTimer.current) clearTimeout(wrongTimer.current)
      wrongTimer.current = setTimeout(() => setWrong(null), 500)
    }
  }

  function pick(side: 'left' | 'right', id: string) {
    // Hearing the word is part of matching it — every tap of a target-language tile speaks it.
    if (side === targetSide && audioOn) {
      const p = pairById(id)
      if (p) onSpeakTarget?.(p)
    }
    if (side === 'left') {
      const next = selLeft === id ? null : id
      setSelLeft(next)
      if (next && selRight) judge(next, selRight, 'left')
    } else {
      const next = selRight === id ? null : id
      setSelRight(next)
      if (next && selLeft) judge(selLeft, next, 'right')
    }
  }

  function playAgain() {
    setRounds(buildRounds(pairs))
    setRound(0)
    setMatched(new Set())
    setSelLeft(null); setSelRight(null); setWrong(null)
    setUnrated(new Map())
    setMistakes(0)
    setElapsed(0)
    setFinished(false)
    startRef.current = Date.now()
  }

  if (finished) {
    if (renderFinish) return <>{renderFinish({ total, mistakes, elapsedMs: elapsed })}</>
    const attempts = total + mistakes
    return (
      <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
        <h1 className="text-2xl font-semibold text-ink">All matched</h1>
        <p className="text-ink-muted text-sm">
          {`${total} pair${total !== 1 ? 's' : ''} in ${fmtTime(elapsed)} with ${mistakes} mistake${mistakes !== 1 ? 's' : ''} (${Math.round((total / attempts) * 100)}% accuracy). Nothing was scheduled — practice doesn’t change your review dates.`}
        </p>
        <div className="flex justify-center gap-3">
          <button onClick={playAgain} className="btn-primary">Play again</button>
          <button onClick={onExit} className="btn-ghost">Back to setup</button>
        </div>
      </div>
    )
  }

  const RATE_OPTIONS: { rating: Rating; label: string; color: string }[] = [
    { rating: 'again', label: 'Again', color: 'border-danger/60 text-danger hover:bg-danger/10' },
    { rating: 'hard',  label: 'Hard',  color: 'border-warning/60 text-warning hover:bg-warning/10' },
    { rating: 'good',  label: 'Good',  color: 'border-success/60 text-success hover:bg-success/10' },
    { rating: 'easy',  label: 'Easy',  color: 'border-accent/60 text-accent-soft hover:bg-accent/10' },
  ]

  const tile = (side: 'left' | 'right', p: MatchPair) => {
    const isMatched  = matched.has(p.id)
    const isSelected = (side === 'left' ? selLeft : selRight) === p.id
    const isWrong    = wrong !== null && (side === 'left' ? wrong.left : wrong.right) === p.id
    const isRating   = unrated.get(p.id) === side
    const button = (
      <button
        key={`${side}-${p.id}`}
        onClick={() => !isMatched && pick(side, p.id)}
        disabled={isMatched}
        className={`w-full rounded-card border px-3 py-3 text-sm leading-snug transition-all select-none ${
          isMatched  ? 'border-success/30 bg-success/5 text-ink-faint/50' :
          isWrong    ? 'border-danger bg-danger/10 text-danger' :
          isSelected ? 'border-accent bg-accent/10 text-accent-soft scale-[1.02]' :
          'border-line/20 text-ink hover:border-line/40 hover:bg-surface-raised cursor-pointer'
        }`}
      >
        {side === targetSide ? p.front : p.back}
      </button>
    )
    if (!isRating) return button
    // Rating overlay on the just-matched tile. Non-blocking: it stays until rated (or the round's
    // Continue button turns it into a Good), and the rest of the board plays on around it.
    return (
      <div key={`${side}-${p.id}`} className="relative">
        {button}
        <div className="absolute inset-0 z-10 flex items-stretch gap-1 rounded-card bg-surface-deep/95 border border-success/40 p-1">
          {RATE_OPTIONS.map(({ rating, label, color }) => (
            <button
              key={rating}
              onClick={() => rateTile(p.id, rating)}
              className={`flex-1 rounded border text-xs font-medium transition-colors ${color}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const done = matched.size
  return (
    <div className="space-y-6 max-w-2xl mx-auto pb-12">
      <div className="flex items-center justify-between gap-4">
        <button onClick={onExit} className="text-sm text-ink-faint hover:text-ink transition-colors">✕ End practice</button>
        <div className="flex items-center gap-4 text-sm text-ink-muted tabular-nums">
          <AudioToggle on={audioOn} onToggle={toggleAudio} />
          <span>{fmtTime(elapsed)}</span>
          {mistakes > 0 && <span className="text-danger">{mistakes} ✗</span>}
          <span>{done} / {total}</span>
        </div>
      </div>

      <div className="h-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${(done / total) * 100}%` }} />
      </div>

      {rounds.length > 1 && (
        <p className="text-xs text-ink-faint text-center uppercase tracking-wider">
          Round {round + 1} of {rounds.length}
        </p>
      )}

      {/* Two independent-shuffled columns; tap one from each. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">{current!.left.map(p => tile('left', p))}</div>
        <div className="space-y-2">{current!.right.map(p => tile('right', p))}</div>
      </div>

      {ratingMode && current!.pairs.every(p => matched.has(p.id)) && (
        <div className="text-center space-y-1.5 pt-2">
          <button className="btn-primary px-10" onClick={continueRound}>
            {round + 1 < rounds.length ? 'Next round' : 'Finish'}
          </button>
          {unrated.size > 0 && (
            <p className="text-xs text-ink-faint">
              {`${unrated.size} unrated match${unrated.size !== 1 ? 'es' : ''} will count as Good.`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
