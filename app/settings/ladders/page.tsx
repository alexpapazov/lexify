'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { LadderEditor } from '@/components/settings/LadderEditor'
import { DEFAULT_LADDER } from '@/domain'
import type { Ladder } from '@/domain'
import { langName } from '@/lib/languages'

function LaddersInner() {
  const params = useSearchParams()
  const source = params.get('source')
  const target = params.get('target')
  const isPair = !!(source && target)

  const [userId, setUserId] = useState<string | null>(null)
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [customized, setCustomized] = useState(false)
  const [pairs, setPairs] = useState<{ source: string; target: string; custom: boolean }[]>([])
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      const uid = session.user.id
      setUserId(uid)
      const repo = new SupabaseLadderRepository()
      const def = await repo.getDefault(uid)
      if (isPair) {
        const pair = await repo.getForPair(uid, source!, target!)
        setCustomized(!!pair)
        setLadder(pair ?? def ?? DEFAULT_LADDER)
      } else {
        setLadder(def ?? DEFAULT_LADDER)
        // List the user's language pairs so they can jump to each one's ladder.
        const decks = await new SupabaseDeckRepository().list(uid)
        const saved = await repo.list(uid)
        const customKeys = new Set(saved.filter(s => s.source && s.target).map(s => `${s.source}|${s.target}`))
        const uniq = Array.from(new Set(decks.map(d => `${d.sourceLanguage}|${d.targetLanguage}`)))
        setPairs(uniq.map(k => { const [s, t] = k.split('|'); return { source: s!, target: t!, custom: customKeys.has(k) } }))
      }
      setVersion(v => v + 1)
    })()
  }, [source, target]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save(l: Ladder) {
    if (!userId) return
    setSaving(true)
    const repo = new SupabaseLadderRepository()
    if (isPair) { await repo.saveForPair(userId, source!, target!, l); setCustomized(true) }
    else await repo.saveDefault(userId, l)
    setSaving(false)
  }
  async function reset() {
    if (!userId || !isPair) return
    setSaving(true)
    const repo = new SupabaseLadderRepository()
    await repo.resetPair(userId, source!, target!)
    const def = await repo.getDefault(userId)
    setLadder(def ?? DEFAULT_LADDER); setCustomized(false); setVersion(v => v + 1); setSaving(false)
  }

  if (!ladder) return <p className="p-6 text-sm text-ink-faint">Loading…</p>

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-5">
      <div>
        {/* Back goes one level up the path you actually took: a per-language ladder returns to the
            ladder list (where you picked it), and the list returns to Language configuration. */}
        <a
          href={isPair ? '/settings/ladders' : '/settings/language'}
          className="text-xs text-ink-faint hover:text-ink"
        >
          ← {isPair ? 'Learning ladders' : 'Language configuration'}
        </a>
        <h1 className="text-2xl font-semibold text-ink mt-1">
          {isPair ? `Learning ladder — ${langName(source!)} → ${langName(target!)}` : 'Default learning ladder'}
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          {isPair
            ? (customized ? 'This language has its own ladder.' : 'Currently using the default ladder — saving here gives this language its own.')
            : 'Applies to any newly added language. Once you edit a language’s own ladder it detaches from this default.'}
        </p>
      </div>

      <LadderEditor key={version} initial={ladder} onSave={save} onReset={isPair && customized ? reset : undefined} saving={saving} />

      {!isPair && pairs.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs text-ink-faint uppercase tracking-wider">Per-language ladders</p>
          {pairs.map(p => (
            <a key={`${p.source}|${p.target}`} href={`/settings/ladders?source=${p.source}&target=${p.target}`}
              className="panel flex items-center justify-between py-3 hover:border-line/10">
              <span className="text-sm text-ink">{langName(p.source)} → {langName(p.target)}</span>
              <span className="chip">{p.custom ? 'custom' : 'default'}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

export default function LaddersPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}><LaddersInner /></Suspense>
}
