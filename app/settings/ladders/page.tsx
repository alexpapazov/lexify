'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabasePathwayRepository } from '@/lib/data/pathways'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { LadderEditor } from '@/components/settings/LadderEditor'
import { PathwayEditor } from '@/components/settings/PathwayEditor'
import { ladderToPathway, emptyPathway } from '@/lib/pathway'
import { DEFAULT_LADDER } from '@/domain'
import type { Ladder, Pathway, LearningMode } from '@/domain'
import { langName } from '@/lib/languages'

function LaddersInner() {
  const params = useSearchParams()
  const source = params.get('source')
  const target = params.get('target')
  const isPair = !!(source && target)
  const effSrc = source ?? ''   // '' = the default (applies to new languages)
  const effTgt = target ?? ''

  const [userId, setUserId] = useState<string | null>(null)
  const [ladder, setLadder] = useState<Ladder | null>(null)
  const [customized, setCustomized] = useState(false)
  const [pairs, setPairs] = useState<{ source: string; target: string; custom: boolean }[]>([])
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState(0)
  const [mode, setMode] = useState<LearningMode>('ladder')
  const [pathway, setPathway] = useState<Pathway | null>(null)
  const [pathwayCustom, setPathwayCustom] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      const uid = session.user.id
      setUserId(uid)
      const repo = new SupabaseLadderRepository()
      const pathRepo = new SupabasePathwayRepository()
      const def = await repo.getDefault(uid)

      const [savedLadder, savedPath, defPath] = await Promise.all([
        isPair ? repo.getForPair(uid, source!, target!) : Promise.resolve(def),
        pathRepo.getForPair(uid, effSrc, effTgt),
        pathRepo.getDefault(uid),
      ])
      const eff = savedLadder ?? def ?? DEFAULT_LADDER
      setLadder(eff)
      setCustomized(isPair ? !!savedLadder : true)
      setPathwayCustom(!!savedPath)
      setPathway(savedPath ?? (isPair ? defPath : null) ?? ladderToPathway(eff))

      // Mode: per-pair flag for a language, or the per-user default on the default page.
      if (isPair) {
        const list = await new SupabaseLanguagePairRepository().list(uid)
        setMode(list.find(p => p.sourceLanguage === source && p.targetLanguage === target)?.learningMode ?? 'ladder')
      } else {
        const { data: prof } = await createClient().from('profiles').select('default_learning_mode').eq('user_id', uid).maybeSingle()
        setMode((prof?.default_learning_mode as LearningMode | null) ?? 'ladder')
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
    await new SupabaseLadderRepository().saveForPair(userId, effSrc, effTgt, l)
    setCustomized(true); setSaving(false)
  }
  async function reset() {
    if (!userId || !isPair) return
    setSaving(true)
    const repo = new SupabaseLadderRepository()
    await repo.resetPair(userId, source!, target!)
    const def = await repo.getDefault(userId)
    setLadder(def ?? DEFAULT_LADDER); setCustomized(false); setVersion(v => v + 1); setSaving(false)
  }

  async function switchMode(next: LearningMode) {
    if (!userId || next === mode) return
    setMode(next)
    if (isPair) await new SupabaseLanguagePairRepository().updateLearningMode(source!, target!, next).catch(() => {})
    else await createClient().from('profiles').update({ default_learning_mode: next }).eq('user_id', userId).then(() => {}, () => {})
    if (next === 'pathway' && !pathway) setPathway(ladderToPathway(ladder ?? DEFAULT_LADDER))
  }
  async function savePathway(p: Pathway) {
    if (!userId) return
    setSaving(true)
    await new SupabasePathwayRepository().saveForPair(userId, effSrc, effTgt, p)
    setPathwayCustom(true); setSaving(false)
  }
  async function resetPathway() {
    if (!userId || !isPair) return
    setSaving(true)
    await new SupabasePathwayRepository().resetPair(userId, source!, target!)
    setPathway(ladderToPathway(ladder ?? DEFAULT_LADDER)); setPathwayCustom(false); setVersion(v => v + 1); setSaving(false)
  }

  if (!ladder) return <p className="p-6 text-sm text-ink-faint">Loading…</p>

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-5">
      <div>
        <a href={isPair ? '/settings/ladders' : '/settings/language'} className="text-xs text-ink-faint hover:text-ink">
          ← {isPair ? 'Learning ladders' : 'Language configuration'}
        </a>

        {/* Mode toggle — at the very top so it's the first thing you set */}
        <div className="inline-flex rounded-lg border border-line/10 p-0.5 text-sm mt-3 mb-3">
          {(['ladder', 'pathway'] as LearningMode[]).map(m => (
            <button key={m} onClick={() => switchMode(m)}
              className={`px-4 py-1.5 rounded-md capitalize transition-colors ${mode === m ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}>
              {m}
            </button>
          ))}
        </div>

        <h1 className="text-2xl font-semibold text-ink">
          {isPair ? `${langName(source!)} → ${langName(target!)}` : `Default learning ${mode}`}
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          {isPair
            ? (mode === 'pathway' ? 'This language learns via a branched pathway.' : (customized ? 'This language has its own ladder.' : 'Using the default ladder — saving here gives this language its own.'))
            : `Applies to any newly added language${mode === 'pathway' ? ' set to pathway mode' : ''}. A language’s own ${mode} overrides it.`}
        </p>
      </div>

      {mode === 'pathway'
        ? <PathwayEditor key={version} initial={pathway ?? emptyPathway()} onSave={savePathway} onReset={isPair && pathwayCustom ? resetPathway : undefined} saving={saving} />
        : <LadderEditor key={version} initial={ladder} onSave={save} onReset={isPair && customized ? reset : undefined} saving={saving} />}

      {!isPair && pairs.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs text-ink-faint uppercase tracking-wider">Per-language</p>
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
