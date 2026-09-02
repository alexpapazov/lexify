'use client'

/**
 * /study/express — express matching review for due reverse-recognition cards.
 *
 * Reached from the Study dashboard's "Study all due → Self-graded · target → native" rows, where
 * the learner chooses Matching or a normal session. The matching game IS the review here: a clean
 * first-try match credits that card's reverse row with a Good (full FSRS scheduling — see
 * lib/expressReview.ts); a card involved in any mismatch is left untouched and stays due for the
 * normal session. Credit lands per match, so exiting mid-game keeps everything already cleared.
 *
 * Reverse recognition only, on purpose: matching word↔meaning is recognition evidence, which is
 * exactly what the reverse track tests — and nothing else. Production (typed / forward self-graded)
 * reviews never come through here.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { SupabaseCardStateRepository } from '@/lib/data/cardStates'
import { SupabaseReviewEventRepository } from '@/lib/data/reviewEvents'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { buildEnabledTracksMap, buildCalibrationMap, buildRetentionMap } from '@/lib/sessionLimits'
import { buildExpressPool, creditExpressMatch, type ExpressCandidate } from '@/lib/expressReview'
import { MatchingGame, type MatchPair, type MatchAttempt } from '@/components/practice/MatchingGame'
import { OfflineUnavailable } from '@/components/offline/OfflineUnavailable'
import { useOfflineMode } from '@/lib/offline/useOfflineMode'
import { getToday } from '@/lib/dates'
import { deviceTimeZone } from '@/lib/offline/profilePrefs'
import { displayText } from '@/lib/cardText'
import { speak } from '@/lib/speak'
import { langName } from '@/lib/languages'

export default function ExpressReviewPage() {
  const offline = useOfflineMode()
  if (offline) return <OfflineUnavailable feature="Express matching" />
  return (
    <Suspense fallback={<div className="text-ink-muted pt-16 text-center">Loading…</div>}>
      <ExpressInner />
    </Suspense>
  )
}

function ExpressInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const source = searchParams.get('source')
  const target = searchParams.get('target')

  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState('')
  const [pool, setPool] = useState<ExpressCandidate[]>([])
  const [skipped, setSkipped] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creditedCount, setCreditedCount] = useState(0)
  const [saveErrors, setSaveErrors] = useState(0)

  const tzRef = useRef(deviceTimeZone())
  const turnoverRef = useRef(0)
  const retMapRef = useRef<Map<string, number>>(new Map())
  const calMapRef = useRef<Map<string, number>>(new Map())
  /** Cards touched by any mismatch this session — they keep their real review. */
  const dirtyRef = useRef<Set<string>>(new Set())
  /** Cards already credited, so a stray double attempt can't credit twice. */
  const creditedRef = useRef<Set<string>>(new Set())

  const stateRepo = useMemo(() => new SupabaseCardStateRepository(), [])
  const eventRepo = useMemo(() => new SupabaseReviewEventRepository(), [])
  const candidateById = useMemo(() => new Map(pool.map(p => [p.card.id, p])), [pool])

  useEffect(() => {
    void (async () => {
      try {
        const supabase = createClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setLoading(false); return }
        const uid = session.user.id
        setUserId(uid)
        const [profileRes, cards, states, paramRows] = await Promise.all([
          supabase.from('profiles').select('timezone, day_turnover_hour').eq('user_id', uid).maybeSingle(),
          new SupabaseCardRepository().listAllForUser(uid),
          stateRepo.listAllForUser(uid),
          new SupabaseUserSchedulerParamsRepository().listForUser(uid),
        ])
        const tz = (profileRes.data?.timezone as string | null) ?? deviceTimeZone()
        const turnover = (profileRes.data?.day_turnover_hour as number | null) ?? 0
        tzRef.current = tz
        turnoverRef.current = turnover
        retMapRef.current = buildRetentionMap(paramRows)
        calMapRef.current = buildCalibrationMap(paramRows)
        const built = buildExpressPool(cards, states, {
          source, target,
          tracksByPair: buildEnabledTracksMap(paramRows),
          tz, today: getToday(tz, turnover),
        })
        setPool(built.pool)
        setSkipped(built.skippedAmbiguous)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        setLoading(false)
      }
    })()
  }, [source, target, stateRepo])

  function handleAttempt(a: MatchAttempt) {
    if (!a.correct) {
      // A mismatch marks BOTH words — the one being matched and the one wrongly chosen. Neither
      // association proved solid, so neither earns credit; both stay due for a real review.
      dirtyRef.current.add(a.pair.id)
      if (a.confused) dirtyRef.current.add(a.confused.id)
      return
    }
    if (dirtyRef.current.has(a.pair.id) || creditedRef.current.has(a.pair.id)) return
    const cand = candidateById.get(a.pair.id)
    if (!cand || !userId) return
    creditedRef.current.add(a.pair.id)
    void creditExpressMatch({
      userId, card: cand.card, state: cand.state, now: new Date(),
      tz: tzRef.current, turnoverHour: turnoverRef.current,
      retMap: retMapRef.current, calMap: calMapRef.current,
      stateRepo, eventRepo,
    }).then(() => setCreditedCount(n => n + 1))
      .catch(err => {
        console.error('Express credit failed:', err)
        creditedRef.current.delete(a.pair.id)
        setSaveErrors(n => n + 1)
      })
  }

  const normalUrl = `/study/all/session?category=due&present=selfgraded&dir=reverse${source && target ? `&source=${source}&target=${target}` : ''}`
  const scopeLabel = source ? `${langName(source)} → ${langName(target ?? '')}` : 'All languages'

  if (loading) return <div className="text-ink-muted pt-16 text-center">Loading…</div>

  if (!userId) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-ink-muted">Sign in to study.</p>
      <Link href="/auth" className="btn-primary inline-block">Sign in</Link>
    </div>
  )

  if (loadError) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <p className="text-danger text-sm">{loadError}</p>
      <Link href="/study" className="btn-primary inline-block">Back to study</Link>
    </div>
  )

  if (pool.length === 0) return (
    <div className="panel text-center space-y-4 py-12 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold text-ink">Nothing to match</h1>
      <p className="text-ink-muted text-sm">
        {skipped > 0
          ? `No matchable recognition cards are due — ${skipped} due card${skipped !== 1 ? 's share' : ' shares'} identical wording with another and need${skipped === 1 ? 's' : ''} a normal review instead.`
          : 'No recognition reviews are due right now.'}
      </p>
      <div className="flex justify-center gap-3">
        {skipped > 0 && <button onClick={() => router.push(normalUrl)} className="btn-primary">Review normally</button>}
        <Link href="/study" className="btn-ghost">Back to study</Link>
      </div>
    </div>
  )

  const pairs: MatchPair[] = pool.map(p => ({
    id: p.card.id,
    front: displayText(p.card.front),
    back: displayText(p.card.back),
  }))

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-faint text-center uppercase tracking-wider">
        Express review · {scopeLabel} · a clean match counts as Good
      </p>
      <MatchingGame
        pairs={pairs}
        onExit={() => router.push('/study')}
        onSpeakTarget={p => {
          const cand = candidateById.get(p.id)
          speak(cand ? cand.card.front : p.front, cand?.card.sourceLanguage ?? source ?? '')
        }}
        onAttempt={handleAttempt}
        renderFinish={({ total, mistakes }) => {
          const missed = total - creditedRef.current.size
          return (
            <div className="max-w-md mx-auto pt-16 space-y-4 text-center">
              <h1 className="text-2xl font-semibold text-ink">Express review done</h1>
              <p className="text-ink-muted text-sm">
                {`${creditedCount} card${creditedCount !== 1 ? 's' : ''} scheduled forward (matched clean, counted as Good).`}
                {missed > 0 && ` ${missed} had a mix-up (${mistakes} wrong pairing${mistakes !== 1 ? 's' : ''}) and stay${missed === 1 ? 's' : ''} due for a real review.`}
                {skipped > 0 && ` ${skipped} more due card${skipped !== 1 ? 's were' : ' was'} left out for sharing identical wording.`}
              </p>
              {saveErrors > 0 && (
                <p className="text-danger text-sm">{`${saveErrors} result${saveErrors !== 1 ? 's' : ''} failed to save — those cards stay due.`}</p>
              )}
              <div className="flex justify-center gap-3">
                {(missed > 0 || skipped > 0) && (
                  <button onClick={() => router.push(normalUrl)} className="btn-primary">
                    {`Review the rest (${missed + skipped})`}
                  </button>
                )}
                <Link href="/study" className="btn-ghost">Back to study</Link>
              </div>
            </div>
          )
        }}
      />
    </div>
  )
}
