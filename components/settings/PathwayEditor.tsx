'use client'

import { useMemo, useState } from 'react'
import type {
  Pathway, PathwayState, Transition, PathwayPredicate, PathwayCounter, ErrorType,
  RungType, RungDirection, DistractorSource, TypedStrictnessLevel, RungOutcome,
} from '@/domain'
import { validatePathway } from '@/lib/pathway'
import { canInitInterval } from '@/lib/ladder'
import { PathwayCanvas } from '@/components/settings/PathwayCanvas'

const TYPE_LABEL: Record<RungType, string> = { mcq: 'Multiple choice', typing: 'Typing', self_graded: 'Self-graded', dictation: 'Dictation' }
const COUNTER_LABEL: Record<PathwayCounter, string> = { consecutiveGood: 'correct in a row', consecutiveAgain: 'wrong in a row', totalGood: 'correct (total)', totalAgain: 'wrong (total)' }
const ERROR_LABEL: Record<ErrorType, string> = { spelling: 'spelling', accent: 'accent', article: 'article', wrong_word: 'wrong word' }
const RATING_LABEL: Record<RungOutcome, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy', almost: 'Almost', miss: 'Wrong' }
const STRICT_CATS = ['spelling', 'accents', 'articles'] as const

let seq = 0
const uid = (p: string) => `${p}${Date.now().toString(36)}${seq++}`
const toMin = (sec: number) => Math.round(sec / 60)
const fromMin = (min: number) => Math.max(0, Math.round(min)) * 60

export function PathwayEditor({ initial, onSave, onReset, saving }: {
  initial: Pathway
  onSave: (p: Pathway) => void
  onReset?: () => void
  saving: boolean
}) {
  const [p, setP] = useState<Pathway>(initial)
  const [selected, setSelected] = useState<string>(initial.startStateId)
  const problems = useMemo(() => validatePathway(p), [p])
  const errors = problems.filter(e => !e.startsWith('Warning:'))
  const warnings = problems.filter(e => e.startsWith('Warning:'))
  const sel = p.states.find(s => s.id === selected)

  const patchState = (id: string, patch: Partial<PathwayState>) =>
    setP(prev => ({ ...prev, states: prev.states.map(s => s.id === id ? { ...s, ...patch } : s) }))
  const moveState = (id: string, pos: { col: number; row: number }) =>
    setP(prev => ({ ...prev, states: prev.states.map(s => s.id === id ? { ...s, pos } : s) }))
  const addState = () => {
    const id = uid('st-')
    const idx = p.states.filter(s => !s.isTerminal).length + 1
    setP(prev => ({ ...prev, states: [...prev.states.filter(s => !s.isTerminal),
      { id, name: `State ${idx}`, type: 'typing', direction: 'produce_target', strictness: { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }, selfRated: false, intervalInit: false },
      ...prev.states.filter(s => s.isTerminal)] }))
    setSelected(id)
  }
  const removeState = (id: string) => {
    setP(prev => ({
      ...prev,
      states: prev.states.filter(s => s.id !== id),
      transitions: prev.transitions.filter(t => t.from !== id && t.to !== id),
      startStateId: prev.startStateId === id ? (prev.states.find(s => s.id !== id && !s.isTerminal)?.id ?? prev.startStateId) : prev.startStateId,
    }))
    setSelected(p.startStateId)
  }

  const patchTransition = (id: string, patch: Partial<Transition>) =>
    setP(prev => ({ ...prev, transitions: prev.transitions.map(t => t.id === id ? { ...t, ...patch } : t) }))
  const addTransition = (from: string) => {
    const to = p.states.find(s => s.isTerminal)?.id ?? p.states[0]!.id
    setP(prev => ({ ...prev, transitions: [...prev.transitions, { id: uid('tr-'), from, to, when: [{ kind: 'correct', is: true }], priority: 100 }] }))
  }
  const removeTransition = (id: string) => setP(prev => ({ ...prev, transitions: prev.transitions.filter(t => t.id !== id) }))
  const patchPredicate = (tid: string, i: number, pred: PathwayPredicate) =>
    setP(prev => ({ ...prev, transitions: prev.transitions.map(t => t.id === tid ? { ...t, when: t.when.map((w, k) => k === i ? pred : w) } : t) }))
  const addPredicate = (tid: string) =>
    setP(prev => ({ ...prev, transitions: prev.transitions.map(t => t.id === tid ? { ...t, when: [...t.when, { kind: 'correct', is: true } as PathwayPredicate] } : t) }))
  const removePredicate = (tid: string, i: number) =>
    setP(prev => ({ ...prev, transitions: prev.transitions.map(t => t.id === tid ? { ...t, when: t.when.filter((_, k) => k !== i) } : t) }))

  const nonTerminal = p.states.filter(s => !s.isTerminal)

  return (
    <div className="space-y-4">
      {/* Global settings */}
      <div className="panel grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-faint">Start state</span>
          <select className="input py-1.5" value={p.startStateId} onChange={e => setP({ ...p, startStateId: e.target.value })}>
            {nonTerminal.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-faint">Minutes between states (default)</span>
          <input type="number" min={0} className="input py-1.5" value={toMin(p.betweenStateWaitSeconds)}
            onChange={e => setP({ ...p, betweenStateWaitSeconds: fromMin(Number(e.target.value)) })} />
        </label>
      </div>

      {/* ── Section 1: the node map ── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink">Map</h3>
          <button className="btn-ghost text-sm py-1.5 px-3" onClick={addState}>+ Add state</button>
        </div>
        <PathwayCanvas pathway={p} selectedStateId={selected} onSelectState={setSelected} onMoveState={moveState} />
        <p className="text-[11px] text-ink-faint">
          Drag a node to reposition it (snaps to the grid) · click a node to edit it below, an arrow to edit its source ·
          <span className="ml-1">● state&nbsp;&nbsp;▢ sets interval&nbsp;&nbsp;🎓 graduation · the dot marks the start</span>
        </p>
      </section>

      {/* ── Section 2: configuration for the selected state ── */}
      <div className="border-t border-line/10 pt-4">
        <h3 className="text-sm font-medium text-ink mb-2">Configuration{sel && !sel.isTerminal ? ` — ${sel.name}` : ''}</h3>
      </div>
      {/* Focused editor for the selected state */}
      {sel && sel.isTerminal && (
        <div className="panel text-sm text-ink-muted">🎓 <span className="text-ink">{sel.name}</span> — reaching this graduates the card. Nothing to configure.</div>
      )}
      {sel && !sel.isTerminal && (
        <div className="panel space-y-3">
          <div className="flex items-center gap-2">
            <input className="input py-1 flex-1 font-medium" value={sel.name} onChange={e => patchState(sel.id, { name: e.target.value })} />
            {p.startStateId === sel.id && <span className="chip">start</span>}
            <button className="text-ink-faint hover:text-danger px-1" onClick={() => removeState(sel.id)} disabled={nonTerminal.length <= 1} title="Delete state">✕</button>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-faint">Exercise</span>
              <select className="input py-1.5" value={sel.type} onChange={e => {
                const type = e.target.value as RungType
                patchState(sel.id, { intervalInit: sel.intervalInit && canInitInterval(type, sel.direction) ? sel.intervalInit : false, type })
              }}>
                {(Object.keys(TYPE_LABEL) as RungType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-faint">Direction</span>
              <select className="input py-1.5" value={sel.direction} onChange={e => {
                const direction = e.target.value as RungDirection
                patchState(sel.id, { intervalInit: sel.intervalInit && canInitInterval(sel.type, direction) ? sel.intervalInit : false, direction })
              }}>
                <option value="produce_target">Produce the target word</option>
                <option value="produce_native">Produce the native word</option>
              </select>
            </label>
          </div>

          {sel.type === 'mcq' && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-ink-faint">Distractors</span>
              <select className="input py-1.5" value={sel.distractorSource ?? 'deck'} onChange={e => patchState(sel.id, { distractorSource: e.target.value as DistractorSource })}>
                <option value="deck">Other cards in the deck</option>
                <option value="smart">AI-generated look-alikes</option>
              </select>
            </label>
          )}
          {(sel.type === 'typing' || sel.type === 'dictation') && (
            <div className="grid grid-cols-3 gap-2 text-sm">
              {STRICT_CATS.map(cat => (
                <label key={cat} className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-ink-faint">{cat}</span>
                  <select className="input py-1 text-xs" value={sel.strictness?.[cat] ?? 'penalize'}
                    onChange={e => patchState(sel.id, { strictness: { ...(sel.strictness ?? { spelling: 'penalize', accents: 'penalize', articles: 'penalize' }), [cat]: e.target.value as TypedStrictnessLevel } })}>
                    <option value="penalize">Penalty + retype</option>
                    <option value="retype">Retype, no penalty</option>
                    <option value="accept">Accept, note only</option>
                  </select>
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="accent-accent" checked={sel.selfRated || sel.type === 'self_graded'} disabled={sel.type === 'self_graded'}
                onChange={e => patchState(sel.id, { selfRated: e.target.checked })} />
              <span className="text-ink">Show rating buttons</span>
            </label>
            {canInitInterval(sel.type, sel.direction) && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-accent" checked={sel.intervalInit}
                  onChange={e => patchState(sel.id, { intervalInit: e.target.checked, selfRated: e.target.checked ? true : sel.selfRated })} />
                <span className="text-ink">Sets this direction&apos;s graduation interval</span>
              </label>
            )}
          </div>

          {/* Transitions out of this state */}
          <div className="flex flex-col gap-2 border-t border-line/10 pt-3">
            <span className="text-xs text-ink-faint">When it goes… move to:</span>
            {p.transitions.filter(t => t.from === sel.id).map(t => (
              <div key={t.id} className="rounded-md border border-line/10 p-2 space-y-2">
                {t.when.length === 0 && <span className="text-xs text-ink-faint italic">Always (no condition)</span>}
                {t.when.map((pred, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-ink-faint">{i === 0 ? 'When' : 'and'}</span>
                    <select className="input py-1 w-auto" value={pred.kind} onChange={e => {
                      const kind = e.target.value as PathwayPredicate['kind']
                      const fresh: PathwayPredicate =
                        kind === 'rating' ? { kind, is: 'good' } :
                        kind === 'correct' ? { kind, is: true } :
                        kind === 'errorType' ? { kind, is: 'accent' } :
                        kind === 'counter' ? { kind, name: 'consecutiveGood', gte: 2 } :
                        { kind: 'attemptsInState', gte: 2 }
                      patchPredicate(t.id, i, fresh)
                    }}>
                      <option value="correct">answer is</option>
                      <option value="rating">rating is</option>
                      <option value="errorType">error is</option>
                      <option value="counter">count of</option>
                      <option value="attemptsInState">attempts ≥</option>
                    </select>
                    {pred.kind === 'correct' && (
                      <select className="input py-1 w-auto" value={pred.is ? '1' : '0'} onChange={e => patchPredicate(t.id, i, { kind: 'correct', is: e.target.value === '1' })}>
                        <option value="1">correct</option><option value="0">wrong</option>
                      </select>
                    )}
                    {pred.kind === 'rating' && (
                      <select className="input py-1 w-auto" value={pred.is} onChange={e => patchPredicate(t.id, i, { kind: 'rating', is: e.target.value as RungOutcome })}>
                        {(['again', 'hard', 'good', 'easy'] as RungOutcome[]).map(r => <option key={r} value={r}>{RATING_LABEL[r]}</option>)}
                      </select>
                    )}
                    {pred.kind === 'errorType' && (
                      <select className="input py-1 w-auto" value={pred.is} onChange={e => patchPredicate(t.id, i, { kind: 'errorType', is: e.target.value as ErrorType })}>
                        {(Object.keys(ERROR_LABEL) as ErrorType[]).map(er => <option key={er} value={er}>{ERROR_LABEL[er]}</option>)}
                      </select>
                    )}
                    {pred.kind === 'counter' && (<>
                      <select className="input py-1 w-auto" value={pred.name} onChange={e => patchPredicate(t.id, i, { kind: 'counter', name: e.target.value as PathwayCounter, gte: pred.gte })}>
                        {(Object.keys(COUNTER_LABEL) as PathwayCounter[]).map(c => <option key={c} value={c}>{COUNTER_LABEL[c]}</option>)}
                      </select>
                      <span className="text-ink-faint">≥</span>
                      <input type="number" min={1} className="input py-1 w-14" value={pred.gte} onChange={e => patchPredicate(t.id, i, { kind: 'counter', name: pred.name, gte: Math.max(1, Number(e.target.value)) })} />
                    </>)}
                    {pred.kind === 'attemptsInState' && (
                      <input type="number" min={1} className="input py-1 w-14" value={pred.gte} onChange={e => patchPredicate(t.id, i, { kind: 'attemptsInState', gte: Math.max(1, Number(e.target.value)) })} />
                    )}
                    <button className="text-ink-faint hover:text-danger px-1" onClick={() => removePredicate(t.id, i)}>✕</button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <button className="text-accent hover:underline" onClick={() => addPredicate(t.id)}>+ and…</button>
                  <span className="text-ink-faint ml-2">→ go to</span>
                  <select className="input py-1 w-auto" value={t.to} onChange={e => patchTransition(t.id, { to: e.target.value })}>
                    {p.states.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                  </select>
                  <span className="text-ink-faint ml-1">priority</span>
                  <input type="number" className="input py-1 w-14" value={t.priority} onChange={e => patchTransition(t.id, { priority: Number(e.target.value) })} title="lower = checked first" />
                  <label className="flex items-center gap-1 ml-1 text-ink-faint">
                    wait
                    <input type="number" min={0} className="input py-1 w-14" placeholder="—" value={t.waitSecondsOverride != null ? toMin(t.waitSecondsOverride) : ''}
                      onChange={e => patchTransition(t.id, { waitSecondsOverride: e.target.value === '' ? undefined : fromMin(Number(e.target.value)) })} title="minutes (blank = use the default)" />
                    min
                  </label>
                  <button className="text-ink-faint hover:text-danger px-1 ml-auto" onClick={() => removeTransition(t.id)}>Remove</button>
                </div>
              </div>
            ))}
            <button className="self-start text-xs text-accent hover:underline" onClick={() => addTransition(sel.id)}>+ Add transition</button>
          </div>
        </div>
      )}

      {/* Validation + save */}
      {errors.length > 0 && (
        <div className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger space-y-1">
          {errors.map((e, i) => <div key={i}>• {e}</div>)}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning space-y-1">
          {warnings.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      <div className="flex gap-3">
        <button className="btn-primary" disabled={saving || errors.length > 0} onClick={() => onSave(p)}>{saving ? 'Saving…' : 'Save pathway'}</button>
        {onReset && <button className="btn-ghost" onClick={onReset}>Revert to default</button>}
      </div>
    </div>
  )
}
