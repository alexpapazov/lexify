/**
 * engine/scheduler.ts
 *
 * Scheduling algorithm hidden behind the Scheduler interface.
 * Swap in SM-2 or FSRS later by calling setActiveScheduler() — nothing else changes.
 */

import type { CardState, Rating } from '@/domain'

export interface ScheduleResult {
  dueAt:        string
  intervalDays: number
  ease:         number
}

export interface Scheduler {
  schedule(state: CardState, rating: Rating): ScheduleResult
}

const INTERVAL_LADDER = [1, 3, 7, 14, 30, 60, 120, 180] as const

function daysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

class LadderScheduler implements Scheduler {
  schedule(state: CardState, rating: Rating): ScheduleResult {
    const { reps, ease } = state
    switch (rating) {
      case 'again':
        return { dueAt: daysFromNow(1), intervalDays: 1, ease: clamp(ease - 0.2, 1.3, 3.0) }
      case 'hard': {
        const interval = INTERVAL_LADDER[clamp(reps, 0, INTERVAL_LADDER.length - 1)]!
        return { dueAt: daysFromNow(interval), intervalDays: interval, ease: clamp(ease - 0.15, 1.3, 3.0) }
      }
      case 'good': {
        const interval = INTERVAL_LADDER[clamp(reps + 1, 0, INTERVAL_LADDER.length - 1)]!
        return { dueAt: daysFromNow(interval), intervalDays: interval, ease }
      }
      case 'easy': {
        const interval = INTERVAL_LADDER[clamp(reps + 2, 0, INTERVAL_LADDER.length - 1)]!
        return { dueAt: daysFromNow(interval), intervalDays: interval, ease: clamp(ease + 0.15, 1.3, 3.0) }
      }
    }
  }
}

let _activeScheduler: Scheduler = new LadderScheduler()

export function getActiveScheduler(): Scheduler { return _activeScheduler }
export function setActiveScheduler(s: Scheduler): void { _activeScheduler = s }
export function scheduleNext(state: CardState, rating: Rating): ScheduleResult {
  return getActiveScheduler().schedule(state, rating)
}
