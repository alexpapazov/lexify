import { useEffect, useRef } from 'react'

/** Idle stretches longer than this aren't counted as study time (you paused / walked away). */
const IDLE_CAP_MS = 40_000

/**
 * Accumulates "active" time for a single review: real elapsed time MINUS any idle gap beyond
 * IDLE_CAP_MS. Call tick() on each user interaction (keypress / tap) and read() when the answer is
 * submitted. A 3-second answer counts as 3s; a 5-minute walk-away counts as 40s and then stops until
 * you interact again.
 */
class ActiveTimer {
  private active = 0
  private last = 0
  constructor(private capMs: number = IDLE_CAP_MS) {}

  restart() { this.active = 0; this.last = Date.now() }

  /** Fold the time since the last interaction into the active total, capping a long idle gap. */
  tick() {
    const now = Date.now()
    this.active += Math.min(now - this.last, this.capMs)
    this.last = now
  }

  read(): number { this.tick(); return Math.round(this.active) }
}

/**
 * A study-session active timer wired to global key/pointer interactions. `restart()` it when a new
 * card is shown; `read()` it when the answer is submitted to get the active response time in ms.
 */
export function useActiveTimer(capMs: number = IDLE_CAP_MS) {
  const ref = useRef<ActiveTimer | null>(null)
  if (ref.current === null) ref.current = new ActiveTimer(capMs)
  useEffect(() => {
    const t = ref.current!
    const tick = () => t.tick()
    window.addEventListener('keydown', tick, true)
    window.addEventListener('pointerdown', tick, true)
    return () => {
      window.removeEventListener('keydown', tick, true)
      window.removeEventListener('pointerdown', tick, true)
    }
  }, [])
  return ref
}
