'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { TOUR_STEPS } from '@/lib/tour'

const KEY = 'lexify-tour'

// A step's `gate` unlocks "Next" only once the user performs the interaction. Each
// gate is a live-DOM predicate polled while its step is active.
const GATE_CHECKS: Record<NonNullable<import('@/lib/tour').TourStep['gate']>, () => boolean> = {
  'library-open': () => !!document.querySelector('[data-tour="library-counter"]'),
  'upload-ai':    () => !!document.querySelector('[data-tour="upload-ai-prompt"]'),
}

/** Signals the tour to start (used by onboarding finish + a "Replay tutorial" button). */
export function startTour() {
  try { localStorage.setItem(KEY, 'running') } catch { /* ignore */ }
  window.dispatchEvent(new Event('lexify:start-tour'))
}

/** Guided product tour: navigates page-to-page, spotlights anchored elements, and
 *  shows a fixed explanation card with Back / Next / Skip. Mounted once in the layout. */
export function Tour() {
  const pathname = usePathname()
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [gatePassed, setGatePassed] = useState(false)

  // Start on the custom event (and on mount if a previous session left it running).
  useEffect(() => {
    try { if (localStorage.getItem(KEY) === 'running') { setRunning(true); setI(0) } } catch { /* ignore */ }
    const onStart = () => { setRunning(true); setI(0) }
    window.addEventListener('lexify:start-tour', onStart)
    return () => window.removeEventListener('lexify:start-tour', onStart)
  }, [])

  const step = running ? TOUR_STEPS[i] : undefined

  const stop = useCallback(() => {
    setRunning(false)
    setRect(null)
    try { localStorage.setItem(KEY, 'done') } catch { /* ignore */ }
  }, [])

  // Navigate to the step's page if we're not already there.
  useEffect(() => {
    if (step && pathname !== step.path) router.push(step.path)
  }, [step, pathname, router])

  // Locate + track the anchored element (poll while the page loads its data).
  useEffect(() => {
    if (!step || pathname !== step.path) { setRect(null); return }
    if (!step.anchor) { setRect(null); return }

    let stop = false
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.anchor}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        setRect(el.getBoundingClientRect())
        return true
      }
      return false
    }
    if (!measure()) {
      const started = Date.now()
      const t = setInterval(() => {
        if (stop || measure() || Date.now() - started > 3000) clearInterval(t)
      }, 150)
      return () => { stop = true; clearInterval(t) }
    }
  }, [step, pathname])

  // Interaction gate: poll the live DOM until the required action is done, then
  // auto-advance to the next step (with a brief beat so the user sees it worked).
  useEffect(() => {
    setGatePassed(false)
    if (!step?.gate || pathname !== step.path) return
    const check = GATE_CHECKS[step.gate]
    let advanceTimer: ReturnType<typeof setTimeout> | undefined
    const onPass = () => {
      setGatePassed(true)
      advanceTimer = setTimeout(() => setI(n => n + 1), 550)
    }
    if (check()) { onPass(); return () => clearTimeout(advanceTimer) }
    const iv = setInterval(() => { if (check()) { clearInterval(iv); onPass() } }, 300)
    return () => { clearInterval(iv); clearTimeout(advanceTimer) }
  }, [step, pathname])

  // Keep the spotlight aligned as the page scrolls, resizes, or the anchored element
  // grows — e.g. an async chart that loads and expands its panel after first measure.
  useEffect(() => {
    if (!step?.anchor) return
    const update = () => {
      const el = document.querySelector(`[data-tour="${step.anchor}"]`)
      if (el) setRect(el.getBoundingClientRect())
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    let ro: ResizeObserver | undefined
    const el = document.querySelector(`[data-tour="${step.anchor}"]`)
    if (el && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(update); ro.observe(el) }
    const iv = setInterval(update, 400) // catch late-loading content the observer can't see yet
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      ro?.disconnect()
      clearInterval(iv)
    }
  }, [step])

  if (!running || !step) return null

  const isLast  = i === TOUR_STEPS.length - 1
  const onPage  = pathname === step.path
  const locked  = !!step.gate && !gatePassed
  const pad = 8

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      {/* Spotlight: a ring around the anchor that dims everything else. Steps
          without a resolved anchor leave the page untouched (no full-page dim). */}
      {onPage && rect && (
        <div
          className="absolute rounded-xl transition-all duration-200"
          style={{
            top: rect.top - pad, left: rect.left - pad,
            width: rect.width + pad * 2, height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            outline: '2px solid rgb(var(--c-accent))',
          }}
        />
      )}

      {/* Explanation card — fixed at the bottom so it never mis-positions. */}
      <div className="pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-md">
        <div className="rounded-card border border-line/10 bg-surface-raised shadow-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">{step.title}</h3>
            <span className="text-xs text-ink-faint">{i + 1} / {TOUR_STEPS.length}</span>
          </div>
          <p className="text-sm text-ink-muted leading-relaxed">{step.body}</p>
          {locked && step.hint && (
            <p className="text-xs text-accent flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {step.hint}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button className="text-xs text-ink-faint hover:text-ink" onClick={stop}>Skip tour</button>
            <div className="flex items-center gap-2">
              {i > 0 && <button className="btn-ghost text-sm py-1.5 px-3" onClick={() => setI(n => n - 1)}>Back</button>}
              {locked
                ? <button className="text-xs text-ink-faint hover:text-ink px-2" onClick={() => setI(n => n + 1)}>Skip step →</button>
                : <button className="btn-primary text-sm py-1.5 px-4" onClick={() => (isLast ? stop() : setI(n => n + 1))}>
                    {isLast ? 'Finish' : 'Next'}
                  </button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
