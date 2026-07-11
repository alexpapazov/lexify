'use client'

import { useState } from 'react'
import type { Ladder, Rung, RungType, RungOutcome, RungDirection, DistractorSource, TypedStrictnessLevel, AdvanceRule } from '@/domain'
import { newRung, validateLadder, canInitInterval } from '@/lib/ladder'

const TYPE_LABEL: Record<RungType, string> = {
  mcq: 'Multiple choice', typing: 'Typing', self_graded: 'Self-graded', dictation: 'Dictation',
}
const OUTCOME_LABEL: Record<RungOutcome, string> = {
  almost: 'Almost', miss: 'Wrong', again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy',
}
const STRICT_CATS = ['spelling', 'accents', 'articles'] as const

/** Width for a small integer input that grows with digit count (1–3 digits). */
const numBoxStyle = (n: number): React.CSSProperties => ({ width: `calc(${Math.min(3, String(n).length || 1)}ch + 1.9rem)` })
/** Clamp a typed count to 1–999 (3 digits max). */
const clampCount = (v: string) => Math.min(999, Math.max(1, Math.floor(Number(v)) || 1))

/** Which outcomes can trigger a drop-back on this rung. */
function availableOutcomes(r: Rung): RungOutcome[] {
  if (r.selfRated || r.type === 'self_graded') return ['again', 'hard', 'good', 'easy']
  if (r.type === 'mcq') return ['miss']
  return ['almost', 'miss'] // typing / dictation, auto-checked
}

export function LadderEditor({ initial, onSave, onReset, saving }: {
  initial: Ladder
  onSave: (ladder: Ladder) => void
  onReset?: () => void           // optional "revert to default" for a pair
  saving?: boolean
}) {
  const [rungs, setRungs] = useState<Rung[]>(initial.rungs)
  const [errors, setErrors] = useState<string[]>([])
  const [savedNote, setSavedNote] = useState(false)

  const update = (id: string, patch: Partial<Rung>) =>
    setRungs(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r))
  const move = (i: number, dir: -1 | 1) =>
    setRungs(rs => { const j = i + dir; if (j < 0 || j >= rs.length) return rs; const c = [...rs]; [c[i], c[j]] = [c[j]!, c[i]!]; return c })
  const remove = (id: string) => setRungs(rs => rs.filter(r => r.id !== id))
  const add = (type: RungType) => setRungs(rs => [...rs, newRung(type)])

  function save() {
    const ladder = { rungs }
    const errs = validateLadder(ladder)
    setErrors(errs)
    if (errs.length === 0) { onSave(ladder); setSavedNote(true); setTimeout(() => setSavedNote(false), 2000) }
  }

  return (
    <div className="space-y-4">
      {rungs.length === 0 && <p className="text-sm text-ink-muted">No rungs yet — add one below.</p>}

      {rungs.map((r, i) => (
        <div key={r.id} className="panel space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Rung {i + 1} · {TYPE_LABEL[r.type]}</span>
            <div className="flex items-center gap-1 text-ink-faint">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="px-2 disabled:opacity-30 hover:text-ink">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === rungs.length - 1} className="px-2 disabled:opacity-30 hover:text-ink">↓</button>
              <button onClick={() => remove(r.id)} className="px-2 hover:text-danger">✕</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            {/* Direction */}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-faint">Direction</span>
              <select className="input py-1.5" value={r.direction} disabled={r.type === 'dictation'}
                onChange={e => update(r.id, { direction: e.target.value as RungDirection })}>
                <option value="produce_target">Produce the target word</option>
                <option value="produce_native">Produce the native word</option>
              </select>
            </label>

            {/* MCQ distractors */}
            {r.type === 'mcq' && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-faint">Distractors</span>
                <select className="input py-1.5" value={r.distractorSource ?? 'deck'}
                  onChange={e => update(r.id, { distractorSource: e.target.value as DistractorSource })}>
                  <option value="deck">Other cards in the deck</option>
                  <option value="smart">AI-generated look-alikes</option>
                </select>
              </label>
            )}
          </div>

          {/* Strictness (typing / dictation) */}
          {(r.type === 'typing' || r.type === 'dictation') && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-ink-faint">Strictness (what a slip costs)</span>
              <div className="grid grid-cols-3 gap-2">
                {STRICT_CATS.map(cat => (
                  <label key={cat} className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase tracking-wider text-ink-faint">{cat}</span>
                    <select className="input py-1 text-xs" value={r.strictness?.[cat] ?? 'penalize'}
                      onChange={e => update(r.id, { strictness: { ...(r.strictness ?? { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }), [cat]: e.target.value as TypedStrictnessLevel } })}>
                      <option value="penalize">Penalty + retype</option>
                      <option value="retype">Retype, no penalty</option>
                      <option value="accept">Accept, note only</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Self-rating + interval-init */}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className={`flex items-center gap-2 ${r.type === 'self_graded' ? 'opacity-60' : 'cursor-pointer'}`}>
              <input type="checkbox" className="accent-accent" checked={r.selfRated || r.type === 'self_graded'}
                disabled={r.type === 'self_graded' || r.intervalInit}
                onChange={e => update(r.id, { selfRated: e.target.checked })} />
              <span className="text-ink">Show rating buttons (Again/Hard/Good/Easy)</span>
            </label>
            {canInitInterval(r.type) && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-accent" checked={r.intervalInit}
                  onChange={e => update(r.id, { intervalInit: e.target.checked, selfRated: e.target.checked ? true : r.selfRated })} />
                <span className="text-ink">Sets this direction&apos;s starting interval</span>
              </label>
            )}
          </div>

          {/* Advance requirement */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {r.intervalInit ? (
              <span className="text-xs text-ink-muted">Advances by rating (Good twice in a row, or Easy) — this graduates the card.</span>
            ) : (() => {
              // OR-able advance rules for every non-interval rung. Self-rated rungs pick a
              // minimum rating per clause; auto-checked ones just need a clean "correct".
              const isSelf = r.selfRated || r.type === 'self_graded'
              const rules: AdvanceRule[] = (r.advanceRules && r.advanceRules.length > 0)
                ? r.advanceRules
                : [{ times: r.advanceTimes, inARow: r.advanceInARow, ...(isSelf ? { minRating: (r.advanceRating ?? 'good') } : {}) }]
              const setRules = (next: AdvanceRule[]) => update(r.id, { advanceRules: next })
              return (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-faint">Advance after</span>
                  {rules.map((rule, i) => (
                    <div key={i} className="flex items-center gap-2">
                      {i > 0 && <span className="text-xs text-accent font-medium">or</span>}
                      <input type="number" min={1} max={999} value={rule.times}
                        onChange={e => setRules(rules.map((x, k) => k === i ? { ...x, times: clampCount(e.target.value) } : x))}
                        className="input py-1 text-center" style={numBoxStyle(rule.times)} />
                      <select className="input py-1 w-auto" value={rule.inARow ? 'row' : 'total'}
                        onChange={e => setRules(rules.map((x, k) => k === i ? { ...x, inARow: e.target.value === 'row' } : x))}>
                        <option value="row">in a row</option>
                        <option value="total">total</option>
                      </select>
                      {isSelf ? (
                        <select className="input py-1 w-auto" value={rule.minRating ?? 'good'}
                          onChange={e => setRules(rules.map((x, k) => k === i ? { ...x, minRating: e.target.value as AdvanceRule['minRating'] } : x))}>
                          <option value="good">Good</option>
                          <option value="easy">Easy</option>
                        </select>
                      ) : <span className="text-xs text-ink-faint">correct</span>}
                      {rules.length > 1 && (
                        <button className="text-ink-faint hover:text-danger text-base leading-none" title="Remove rule"
                          onClick={() => setRules(rules.filter((_, k) => k !== i))}>×</button>
                      )}
                    </div>
                  ))}
                  <button className="text-xs text-accent hover:underline"
                    onClick={() => setRules([...rules, isSelf ? { times: 1, inARow: true, minRating: 'good' } : { times: 1, inARow: true }])}>+ or</button>
                </div>
              )
            })()}
          </div>

          {/* Drop-back rules */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-faint">If it goes wrong, drop back:</span>
            {r.dropBacks.map((rule, ri) => (
              <div key={ri} className="flex items-center gap-2 text-sm">
                <span className="text-ink-faint text-xs">On</span>
                <select className="input py-1 w-auto" value={rule.on}
                  onChange={e => update(r.id, { dropBacks: r.dropBacks.map((x, k) => k === ri ? { ...x, on: e.target.value as RungOutcome } : x) })}>
                  {availableOutcomes(r).map(o => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
                </select>
                <input type="number" min={1} max={999} value={rule.times} title="after this many times"
                  onChange={e => update(r.id, { dropBacks: r.dropBacks.map((x, k) => k === ri ? { ...x, times: clampCount(e.target.value) } : x) })}
                  className="input py-1 text-center" style={numBoxStyle(rule.times)} />
                <select className="input py-1 w-auto" value={rule.inARow ? 'row' : 'total'}
                  onChange={e => update(r.id, { dropBacks: r.dropBacks.map((x, k) => k === ri ? { ...x, inARow: e.target.value === 'row' } : x) })}>
                  <option value="total">total</option>
                  <option value="row">in a row</option>
                </select>
                <span className="text-ink-faint text-xs">→ go to</span>
                <select className="input py-1 w-auto" value={rule.toRungId}
                  onChange={e => update(r.id, { dropBacks: r.dropBacks.map((x, k) => k === ri ? { ...x, toRungId: e.target.value } : x) })}>
                  {rungs.map((rr, k) => <option key={rr.id} value={rr.id}>Rung {k + 1}</option>)}
                </select>
                <button className="text-ink-faint hover:text-danger px-1" onClick={() => update(r.id, { dropBacks: r.dropBacks.filter((_, k) => k !== ri) })}>✕</button>
              </div>
            ))}
            <button className="self-start text-xs text-accent hover:underline"
              onClick={() => update(r.id, { dropBacks: [...r.dropBacks, { on: availableOutcomes(r)[0]!, times: 1, toRungId: rungs[0]!.id }] })}>
              + Add drop-back rule
            </button>
          </div>
        </div>
      ))}

      {/* Add rung */}
      <div className="flex flex-wrap gap-2">
        {(['mcq', 'typing', 'self_graded', 'dictation'] as RungType[]).map(t => (
          <button key={t} onClick={() => add(t)} className="btn-ghost text-sm py-1.5 px-3">+ {TYPE_LABEL[t]}</button>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="text-sm text-danger space-y-1">{errors.map((e, i) => <p key={i}>• {e}</p>)}</div>
      )}

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save ladder'}</button>
        {onReset && <button className="btn-ghost" onClick={onReset} disabled={saving}>Revert to default</button>}
        {savedNote && <span className="text-sm text-success">Saved.</span>}
      </div>
    </div>
  )
}
