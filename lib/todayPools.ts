/**
 * lib/todayPools.ts — how a group of due cards is PRESENTED, split into the three session pools:
 * typed production, self-graded forward, and reverse recall. Extracted VERBATIM from the study
 * dashboard's per-deck stats block (2026-10-04) so the dashboard's due-picker counts and the
 * Today page's category rows share one definition and cannot drift. Pure — no React, no Supabase.
 *
 * Classification mirrors the sessions: a due forward card presents TYPED when the enabled
 * production lane says so (`forwardProductionMode` vs the pair's smart-typing threshold), else
 * self-graded; reverse rows are their own pool, gated on the forward row being graduated and the
 * reverse row's own dormancy (dormancy is per-direction).
 */

import type { CardState } from '@/domain'
import { trackEnabled, activeProductionTrack, forwardProductionMode, type EnabledTracks } from '@/lib/sessionLimits'

export interface DuePools {
  /** Due forward rows presented TYPED (the enabled production lane, under the threshold). */
  typing:    CardState[]
  /** Due forward rows presented SELF-GRADED (recall-only due, or production past the threshold). */
  sgForward: CardState[]
  /** Due reverse rows (recognition). */
  reverse:   CardState[]
}

export function deckDuePools(opts: {
  /** Every state row for the group's cards, both directions. */
  states:      CardState[]
  /** cardId → forward row (the authoritative graduation source for the reverse gate). */
  forwardMap:  Map<string, CardState>
  tracks:      EnabledTracks | undefined
  /** The pair's smart-typing threshold (days) — presentation flips to self-graded past it. */
  smartThresholdDays: number
  tz:          string
  /** Local study-day (turnover-aware), YYYY-MM-DD. */
  today:       string
}): DuePools {
  const { states, forwardMap, tracks: en, smartThresholdDays: threshold, tz, today } = opts

  const isDueByDate = (dateStr: string | null | undefined) =>
    !!dateStr && new Date(dateStr).toLocaleDateString('en-CA', { timeZone: tz }) <= today
  // Track-aware due checks — a disabled track never counts as due. Production is one lane
  // (typed/smart mutually exclusive), visible if EITHER production mode is enabled (smart defaults
  // off, so gating on it alone would hide migrated production). Legacy cards (no typed/smart due
  // date) fall back to dueAt.
  const prodEnabled = trackEnabled(en, 'typed', false) || trackEnabled(en, 'smart', false)
  const prodDueOn   = (s: CardState) => !s.dormant && prodEnabled && (
    s.smartDueAt ? isDueByDate(s.smartDueAt)
    : s.typedDueAt ? isDueByDate(s.typedDueAt)
    : isDueByDate(s.dueAt))
  const recallDueOn = (s: CardState) => !s.dormant && trackEnabled(en, 'recall', false) && isDueByDate(s.recallDueAt)
  // Reverse rows are scheduled by recall_due_at; their due_at is often stale in the past. Prefer
  // recall_due_at (fall back to due_at only when recall is null). Dormancy is per-direction: gate
  // on the REVERSE row's own `dormant` only; the forward GRADUATED check stays.
  const reverseDueOn = (s: CardState) => trackEnabled(en, 'recall', true) &&
    forwardMap.get(s.cardId)?.graduated === true &&
    !s.dormant && isDueByDate(s.recallDueAt ?? s.dueAt)
  // How a due forward card is presented (mirrors the session: enabled production lane wins over
  // recall). Uses the active lane (not the date column) so a legacy/ladder card scheduled on
  // due_at/typed_due_at is classified the same way the session presents it.
  const prodTrack = activeProductionTrack(en)
  const forwardPresentedTyping = (s: CardState) => {
    if (prodTrack && prodDueOn(s)) return forwardProductionMode(s, prodTrack, threshold) === 'typed'
    return false  // recall-only due → self-graded
  }

  const typing: CardState[] = []
  const sgForward: CardState[] = []
  const reverse: CardState[] = []
  for (const s of states) {
    if (!s.graduated) continue
    if (s.reviewDirection === 'reverse') {
      if (reverseDueOn(s)) reverse.push(s)
      continue
    }
    if (!(prodDueOn(s) || recallDueOn(s))) continue
    if (forwardPresentedTyping(s)) typing.push(s)
    else sgForward.push(s)
  }
  return { typing, sgForward, reverse }
}
