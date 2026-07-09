'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseChangeSetRepository } from '@/lib/data/changeSets'
import { runAgentAndSave } from '@/lib/agents/runClient'
import type { Deck, Grant, ChangeSet } from '@/domain'

const DEFAULT_TASK =
  'Find cards whose back (native-language gloss) holds two or more distinct meanings (e.g. "hi / hello", "leader; guide") and split them so each card has one clean gloss. Leave clean cards alone.'

export default function AgentsPage() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [decks, setDecks] = useState<Deck[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())  // "deck:<id>" | "pair:<src>|<tgt>"
  const [task, setTask] = useState(DEFAULT_TASK)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<Omit<ChangeSet, 'items'>[]>([])

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      const ds = await new SupabaseDeckRepository().list(session.user.id)
      setDecks(ds)
      setRecent(await new SupabaseChangeSetRepository().listForUser(session.user.id, 10))
    })()
  }, [])

  const pairs = Array.from(new Set(decks.map(d => `${d.sourceLanguage}|${d.targetLanguage}`)))

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Expand every selection (whole pairs + individual decks) into a union of deck ids.
  function scopedDeckIds(): string[] {
    const ids = new Set<string>()
    for (const key of selected) {
      if (key.startsWith('deck:')) ids.add(key.slice(5))
      else if (key.startsWith('pair:')) {
        const pair = key.slice(5)
        decks.filter(d => `${d.sourceLanguage}|${d.targetLanguage}` === pair).forEach(d => ids.add(d.id))
      }
    }
    return [...ids]
  }

  function grantFromScope(): Grant {
    return { operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds: scopedDeckIds(), dryRunOnly: true }
  }

  const inScopeDeckCount = scopedDeckIds().length

  async function run() {
    if (!userId || selected.size === 0 || running) return
    setRunning(true); setError(null)
    try {
      const id = await runAgentAndSave({ agentId: 'card-editor', userId, grant: grantFromScope(), task })
      router.push(`/agents/review/${id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRunning(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Card editor agent</h1>
        <p className="text-sm text-ink-muted mt-1">Runs in dry-run mode — it proposes changes you review and approve before anything is saved.</p>
      </div>

      <div className="panel space-y-4">
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <label className="text-xs text-ink-faint">Scope — select what the agent may touch</label>
            <span className="text-xs text-ink-faint">{inScopeDeckCount} deck{inScopeDeckCount === 1 ? '' : 's'} in scope</span>
          </div>
          <div className="border border-white/10 rounded-lg max-h-64 overflow-y-auto divide-y divide-white/5">
            {pairs.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-faint bg-surface/50 sticky top-0">Whole language pair</div>
                {pairs.map(p => {
                  const key = `pair:${p}`
                  return (
                    <label key={key} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface/40">
                      <input type="checkbox" className="accent-accent" checked={selected.has(key)} onChange={() => toggle(key)} />
                      <span className="text-sm text-ink">All {p.replace('|', ' → ')} decks</span>
                    </label>
                  )
                })}
              </>
            )}
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-faint bg-surface/50 sticky top-0">Single deck</div>
            {decks.map(d => {
              const key = `deck:${d.id}`
              return (
                <label key={key} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface/40">
                  <input type="checkbox" className="accent-accent" checked={selected.has(key)} onChange={() => toggle(key)} />
                  <span className="text-sm text-ink truncate">{d.name} <span className="text-ink-faint">({d.sourceLanguage}→{d.targetLanguage})</span></span>
                </label>
              )
            })}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-ink-faint">Task</label>
          <textarea className="input min-h-[96px]" value={task} onChange={e => setTask(e.target.value)} />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button className="btn-primary w-full" disabled={selected.size === 0 || running || !userId} onClick={run}>
          {running ? 'Running… (this can take a moment)' : 'Run card editor'}
        </button>
      </div>

      {recent.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-ink-faint uppercase tracking-wider">Recent runs</p>
          {recent.map(cs => (
            <a key={cs.id} href={`/agents/review/${cs.id}`} className="panel flex items-center justify-between py-3 hover:border-white/10">
              <span className="text-sm text-ink truncate">{cs.agent} · {new Date(cs.createdAt).toLocaleString()}</span>
              <span className="chip">{cs.status}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
