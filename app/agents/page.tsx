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
  const [scope, setScope] = useState('')                 // "deck:<id>" | "pair:<src>|<tgt>"
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

  function grantFromScope(): Grant {
    const base: Grant = { operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds: [], dryRunOnly: true }
    if (scope.startsWith('deck:'))  return { ...base, deckIds: [scope.slice(5)] }
    if (scope.startsWith('pair:'))  return { ...base, languages: [scope.slice(5)] }
    return base
  }

  async function run() {
    if (!userId || !scope || running) return
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
          <label className="text-xs text-ink-faint">Scope</label>
          <select className="input" value={scope} onChange={e => setScope(e.target.value)}>
            <option value="">Select what the agent may touch…</option>
            {pairs.length > 0 && (
              <optgroup label="Whole language pair">
                {pairs.map(p => <option key={p} value={`pair:${p}`}>All {p.replace('|', ' → ')} decks</option>)}
              </optgroup>
            )}
            <optgroup label="Single deck">
              {decks.map(d => <option key={d.id} value={`deck:${d.id}`}>{d.name} ({d.sourceLanguage}→{d.targetLanguage})</option>)}
            </optgroup>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-ink-faint">Task</label>
          <textarea className="input min-h-[96px]" value={task} onChange={e => setTask(e.target.value)} />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button className="btn-primary w-full" disabled={!scope || running || !userId} onClick={run}>
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
