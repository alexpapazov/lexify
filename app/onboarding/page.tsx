'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SupabaseLanguagePairRepository } from '@/lib/data/languagePairs'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'
import { SupabaseLadderRepository } from '@/lib/data/ladders'
import { SupabaseFolderRepository } from '@/lib/data/folders'
import { SupabaseDeckRepository } from '@/lib/data/decks'
import { SupabaseCardRepository } from '@/lib/data/cards'
import { starterFoldersFor } from '@/lib/starterContent'
import { startTour } from '@/components/Tour'
import { LANGUAGES, langFlag, langName } from '@/lib/languages'

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'
import {
  STUDY_STYLES, tracksForStyle, LADDER_PRESETS, PACES, goalsForPace,
  type StudyStyle, type LadderDepth, type Pace,
} from '@/lib/onboarding'

type Theme = 'dark' | 'light'
const STEPS = ['welcome', 'languages', 'style', 'ladder', 'pace', 'theme'] as const
const LADDER_ORDER: LadderDepth[] = ['quick', 'standard', 'thorough']

function detectNative(): string {
  try {
    const code = navigator.language.split('-')[0]!.toLowerCase()
    return LANGUAGES.some(l => l.code === code) ? code : 'en'
  } catch { return 'en' }
}

export default function OnboardingPage() {
  const [step, setStep] = useState(0)

  // choices
  const [native, setNative]     = useState('en')
  const [learning, setLearning] = useState<Set<string>>(new Set())
  const [style, setStyle]       = useState<StudyStyle>('smart')
  const [reverse, setReverse]   = useState(true)
  const [depth, setDepth]       = useState<LadderDepth>('standard')
  const [pace, setPace]         = useState<Pace>('regular')
  const [theme, setTheme]       = useState<Theme>('dark')

  const [applying, setApplying] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    setNative(detectNative())
    setTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark')
  }, [])

  // Preview the theme live as it's toggled.
  function pickTheme(t: Theme) {
    setTheme(t)
    document.documentElement.classList.toggle('light', t === 'light')
    try { localStorage.setItem('lexify-theme', t) } catch { /* ignore */ }
  }

  function toggleLearning(code: string) {
    setLearning(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code); else next.add(code)
      return next
    })
  }

  const isLast   = step === STEPS.length - 1
  const canNext  = step !== 1 || learning.size > 0

  async function skip() {
    setApplying(true)
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (session) await supabase.from('profiles').update({ onboarding_completed: true }).eq('user_id', session.user.id)
      // Hard navigation so AuthWall re-reads the (now-completed) onboarding flag.
      window.location.href = '/study'
    } catch { setApplying(false) }
  }

  async function finish() {
    setError(null)
    setApplying(true)
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const uid = session.user.id

      const pairRepo   = new SupabaseLanguagePairRepository()
      const paramRepo  = new SupabaseUserSchedulerParamsRepository()
      const ladderRepo = new SupabaseLadderRepository()
      const folderRepo = new SupabaseFolderRepository()
      const deckRepo   = new SupabaseDeckRepository()
      const cardRepo   = new SupabaseCardRepository()

      // Default ladder for every newly added language.
      await ladderRepo.saveDefault(uid, LADDER_PRESETS[depth].ladder)

      const flags = tracksForStyle(style, reverse)
      const goals = goalsForPace(PACES.find(p => p.id === pace)!.perDay)

      for (const learned of learning) {
        if (learned === native) continue
        await pairRepo.create(uid, learned, native, langFlag(learned))
        await pairRepo.updateGoals(learned, native, goals)
        // Ensure each track's row exists, then set its enabled flag.
        for (const [field, key] of [
          ['forward_typed',  'forward_typed_enabled'],
          ['forward_smart',  'forward_smart_enabled'],
          ['forward_recall', 'forward_recall_enabled'],
          ['reverse_recall', 'reverse_recall_enabled'],
        ] as const) {
          await paramRepo.getOrCreate(uid, learned, native, field)
          await paramRepo.update(uid, learned, native, field, { [key]: flags[key] })
        }

        // Seed starter folders (Common Phrases + Numbers) so there's something to study.
        for (const sf of starterFoldersFor(learned, native)) {
          const folder = await folderRepo.create(uid, sf.name, null, { sourceLanguage: learned, targetLanguage: native })
          const deck = await deckRepo.create(uid, { name: sf.name, sourceLanguage: learned, targetLanguage: native, pipelineId: DEFAULT_PIPELINE_ID })
          await deckRepo.update(deck.id, { folderId: folder.id })
          await cardRepo.bulkCreate(deck.id, uid, learned, native, sf.cards.map((c, i) => ({ front: c.front, back: c.back, position: i })))
        }
      }

      try { localStorage.setItem('lexify-theme', theme) } catch { /* ignore */ }
      await supabase.from('profiles').update({ onboarding_completed: true }).eq('user_id', uid)

      // Kick off the guided tour on the next page (persists across the reload).
      startTour()
      // Hard navigation so AuthWall re-reads the (now-completed) onboarding flag.
      window.location.href = '/study'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed — please try again.')
      setApplying(false)
    }
  }

  const learnableLangs = LANGUAGES.filter(l => l.code !== native)

  return (
    <div className="max-w-lg mx-auto py-6">
      {/* Progress dots (config steps only) */}
      {step > 0 && (
        <div className="flex justify-center gap-1.5 mb-8">
          {STEPS.slice(1).map((_, i) => (
            <span key={i} className={`h-1.5 rounded-full transition-all ${i + 1 <= step ? 'w-6 bg-accent' : 'w-1.5 bg-line/20'}`} />
          ))}
        </div>
      )}

      <div className="min-h-[26rem]">
        {step === 0 && (
          <div className="text-center space-y-5 pt-10">
            <div className="text-6xl">📚</div>
            <h1 className="text-3xl font-semibold text-ink">Welcome to Lexify</h1>
            <p className="text-ink-muted leading-relaxed max-w-sm mx-auto">
              Let&apos;s set things up the way you like — it takes about a minute. You can change any of this later in Settings.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <StepHeader title="Your languages" subtitle="Pick your native language and the ones you want to learn." />
            <div className="space-y-1.5">
              <label className="text-sm text-ink-muted">I speak</label>
              <select className="input" value={native} onChange={e => setNative(e.target.value)}>
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm text-ink-muted">I&apos;m learning <span className="text-ink-faint">(pick one or more)</span></label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {learnableLangs.map(l => {
                  const on = learning.has(l.code)
                  return (
                    <button key={l.code} type="button" onClick={() => toggleLearning(l.code)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${on ? 'border-accent bg-accent/15 text-ink' : 'border-line/10 text-ink-muted hover:text-ink hover:border-line/20'}`}>
                      <span className="text-base">{l.flag}</span>
                      <span className="truncate">{l.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <StepHeader title="How do you want to review?" subtitle="This sets your daily review style. You can mix and match per language later." />
            <div className="space-y-2">
              {STUDY_STYLES.map(s => (
                <ChoiceCard key={s.id} selected={style === s.id} onClick={() => setStyle(s.id)}
                  icon={s.icon} title={s.title} desc={s.desc} />
              ))}
            </div>
            <label className="flex items-center gap-3 px-1 pt-1 cursor-pointer">
              <input type="checkbox" checked={reverse} onChange={e => setReverse(e.target.checked)}
                className="w-4 h-4 accent-accent" />
              <span className="text-sm text-ink-muted">Also quiz me in reverse — see the word, recall its meaning</span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <StepHeader title="New-word practice" subtitle="How thorough should a new word's learning path be before it graduates to review?" />
            <div className="space-y-2">
              {LADDER_ORDER.map(d => (
                <ChoiceCard key={d} selected={depth === d} onClick={() => setDepth(d)}
                  title={LADDER_PRESETS[d].title} desc={LADDER_PRESETS[d].desc} />
              ))}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <StepHeader title="Daily pace" subtitle="How many new words per day, per language? Drives your daily goal and workload forecast." />
            <div className="space-y-2">
              {PACES.map(p => (
                <ChoiceCard key={p.id} selected={pace === p.id} onClick={() => setPace(p.id)}
                  title={`${p.label} · ${p.perDay}/day`} desc={p.desc} />
              ))}
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-5">
            <StepHeader title="Appearance" subtitle="Pick a theme — you can switch anytime in Settings." />
            <div className="grid grid-cols-2 gap-3">
              {(['dark', 'light'] as Theme[]).map(t => (
                <button key={t} type="button" onClick={() => pickTheme(t)}
                  className={`p-5 rounded-xl border text-center transition-colors ${theme === t ? 'border-accent bg-accent/10' : 'border-line/10 hover:border-line/20'}`}>
                  <div className="text-3xl mb-2">{t === 'dark' ? '🌙' : '☀️'}</div>
                  <div className="text-sm font-medium text-ink capitalize">{t}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-danger text-sm text-center mb-3">{error}</p>}

      {/* Footer nav */}
      <div className="flex items-center justify-between gap-3 mt-6">
        {step > 0
          ? <button className="btn-ghost text-sm" onClick={() => setStep(s => s - 1)} disabled={applying}>Back</button>
          : <button className="text-sm text-ink-faint hover:text-ink" onClick={skip} disabled={applying}>Skip for now</button>}

        {isLast ? (
          <button className="btn-primary" onClick={finish} disabled={applying}>
            {applying ? 'Setting up…' : 'Finish setup'}
          </button>
        ) : (
          <button className="btn-primary" onClick={() => setStep(s => s + 1)} disabled={!canNext || applying}>
            {step === 0 ? 'Get started' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  )
}

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="text-sm text-ink-muted leading-relaxed">{subtitle}</p>
    </div>
  )
}

function ChoiceCard({ selected, onClick, icon, title, desc }: {
  selected: boolean; onClick: () => void; icon?: string; title: string; desc: string
}) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-start gap-3 text-left p-4 rounded-xl border transition-colors ${selected ? 'border-accent bg-accent/10' : 'border-line/10 hover:border-line/20'}`}>
      {icon && <span className="text-2xl leading-none mt-0.5">{icon}</span>}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="block text-xs text-ink-muted leading-relaxed mt-0.5">{desc}</span>
      </span>
      <span className={`ml-auto mt-0.5 w-4 h-4 rounded-full border shrink-0 ${selected ? 'border-accent bg-accent' : 'border-line/30'}`} />
    </button>
  )
}
