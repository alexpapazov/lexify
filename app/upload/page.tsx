'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }          from '@/lib/data/decks'
import { SupabaseCardRepository }          from '@/lib/data/cards'
import { SupabasePipelineRepository }      from '@/lib/data/pipelines'
import { SupabaseDismissedPairRepository } from '@/lib/data/dismissedPairs'
import { LanguageCombobox } from '@/components/LanguageCombobox'
import { prefetchChoices, type PrefetchItem } from '@/lib/distractors'
import {
  INSTRUCTIONS_CHAR_CAP, INPUT_WORD_CAP,
  analyzeDuplicate, type DuplicateAnalysis,
} from '@/lib/duplicates'
import type { Card } from '@/domain'

type SeparatorOption = 'tab' | 'newline' | 'custom'
type AiMode = 'wordlist' | 'extraction'
type Stage = 'edit' | 'preview'

interface ParsedCard { front: string; back: string }

interface CandidateCard {
  front:           string
  back:            string
  languageWarning: 'front' | 'back' | 'both' | null
}

interface PreviewItem {
  front:     string
  back:      string
  include:   boolean
  duplicate: DuplicateAnalysis | null
  action:    'create' | 'merge' | 'keep-both'
}

function parseCards(raw: string, cardSep: string, pairSep: string): ParsedCard[] {
  return raw.split(cardSep).map(l => l.trim()).filter(Boolean).map(line => {
    const idx = line.indexOf(pairSep)
    if (idx === -1) return null
    return { front: line.slice(0, idx).trim(), back: line.slice(idx + pairSep.length).trim() }
  }).filter((c): c is ParsedCard => c !== null && c.front.length > 0 && c.back.length > 0)
}

function sepChar(opt: SeparatorOption, custom: string): string {
  if (opt === 'tab')     return '\t'
  if (opt === 'newline') return '\n'
  return custom || '\t'
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).filter(Boolean).length
}

function reasonToMessage(reason: string): string {
  switch (reason) {
    case 'no-api-key':            return 'AI card generation is not configured for this app yet.'
    case 'content-too-long':      return `Your word list exceeds the ${INPUT_WORD_CAP}-word limit.`
    case 'text-too-long':         return `Your text exceeds the ${INPUT_WORD_CAP}-word limit.`
    case 'instructions-too-long': return `Prompt exceeds the ${INSTRUCTIONS_CHAR_CAP}-character limit.`
    case 'empty-content':         return 'Please enter some content first.'
    case 'parse-error':           return 'Could not understand the AI response. Please try again.'
    case 'api-error':             return 'AI service error. Please try again.'
    default:                       return 'Something went wrong running the agent. Please try again.'
  }
}

/** Example words per language code: [apple, water] */
const EXAMPLES: Record<string, [string, string]> = {
  en:  ['apple',       'water'],
  es:  ['la manzana',  'el agua'],
  fr:  ['la pomme',    "l'eau"],
  de:  ['der Apfel',   'das Wasser'],
  it:  ["la mela",     "l'acqua"],
  pt:  ['a maçã',      'a água'],
  nl:  ['de appel',    'het water'],
  ru:  ['яблоко',      'вода'],
  zh:  ['苹果',         '水'],
  ja:  ['りんご',        '水'],
  ko:  ['사과',         '물'],
  ar:  ['تفاحة',       'ماء'],
  hi:  ['सेब',         'पानी'],
  tr:  ['elma',        'su'],
  pl:  ['jabłko',      'woda'],
  sv:  ['äpplet',      'vatten'],
  no:  ['eplet',       'vann'],
  da:  ['æblet',       'vand'],
  fi:  ['omena',       'vesi'],
  el:  ['μήλο',        'νερό'],
  he:  ['תפוח',        'מים'],
  uk:  ['яблуко',      'вода'],
  bg:  ['ябълка',      'вода'],
  cs:  ['jablko',      'voda'],
  hu:  ['alma',        'víz'],
  ro:  ['mărul',       'apa'],
  vi:  ['quả táo',     'nước'],
  th:  ['แอปเปิ้ล',   'น้ำ'],
  id:  ['apel',        'air'],
  ms:  ['epal',        'air'],
  asl: ['APPLE',       'WATER'],
  bsl: ['APPLE',       'WATER'],
}

function exampleWord(code: string, idx: 0 | 1): string {
  return (EXAMPLES[code] ?? EXAMPLES['en']!)[idx]
}

/** Build a placeholder matching separator settings and chosen languages. */
function buildPlaceholder(
  pairOpt: SeparatorOption, customPair: string,
  cardOpt: SeparatorOption, customCard: string,
  frontLang: string, backLang: string,
): string {
  const pDisplay = pairOpt === 'tab' ? '\t' : pairOpt === 'newline' ? '\n' : (customPair || '…')
  const cDisplay = cardOpt === 'newline' ? '\n' : cardOpt === 'tab' ? '\t' : (customCard || '…')
  const f1 = exampleWord(frontLang, 0);  const b1 = exampleWord(backLang, 0)
  const f2 = exampleWord(frontLang, 1);  const b2 = exampleWord(backLang, 1)
  return `${f1}${pDisplay}${b1}${cDisplay}${f2}${pDisplay}${b2}`
}

function SeparatorPicker({ label, value, onChange, custom, onCustomChange }: {
  label: string; value: SeparatorOption; onChange: (v: SeparatorOption) => void
  custom: string; onCustomChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-sm text-ink-muted">{label}</span>
      <div className="flex flex-wrap gap-3">
        {(['tab', 'newline', 'custom'] as SeparatorOption[]).map(opt => (
          <label key={opt} className="flex items-center gap-1.5 cursor-pointer text-sm text-ink">
            <input type="radio" name={label} checked={value === opt} onChange={() => onChange(opt)} className="accent-accent" />
            {opt === 'tab' ? 'Tab' : opt === 'newline' ? 'Enter' : 'Custom'}
          </label>
        ))}
      </div>
      {value === 'custom' && (
        <input className="input text-sm" placeholder='e.g. | or ;' value={custom} onChange={e => onCustomChange(e.target.value)} />
      )}
    </div>
  )
}

/** Pill-style toggle between "Wordlist" and "Extract Text". */
function ModeSwitch({ value, onChange }: { value: AiMode; onChange: (v: AiMode) => void }) {
  return (
    <div className="inline-flex items-center rounded-full border border-white/10 bg-surface p-1 text-sm shrink-0">
      <button
        type="button"
        onClick={() => onChange('wordlist')}
        className={`px-3 py-1 rounded-full transition-colors ${value === 'wordlist' ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}
      >
        Wordlist
      </button>
      <button
        type="button"
        onClick={() => onChange('extraction')}
        className={`px-3 py-1 rounded-full transition-colors ${value === 'extraction' ? 'bg-accent text-white' : 'text-ink-muted hover:text-ink'}`}
      >
        Extract Text
      </button>
    </div>
  )
}

export default function UploadPage() {
  const [rawText,       setRawText]       = useState('')
  const [deckName,      setDeckName]      = useState('')
  const [pairSepOpt,    setPairSepOpt]    = useState<SeparatorOption>('tab')
  const [cardSepOpt,    setCardSepOpt]    = useState<SeparatorOption>('newline')
  const [customPairSep, setCustomPairSep] = useState('')
  const [customCardSep, setCustomCardSep] = useState('')

  const [aiFormatEnabled, setAiFormatEnabled] = useState(false)
  const [aiMode,          setAiMode]          = useState<AiMode>('wordlist')
  const [aiPrompt,        setAiPrompt]        = useState('')
  const [agentRunning,    setAgentRunning]    = useState(false)
  const [agentRan,        setAgentRan]        = useState(false)
  const [agentError,      setAgentError]      = useState<string | null>(null)

  const [targetLang,    setTargetLang]    = useState('')
  const [basisLang,     setBasisLang]     = useState('')
  const [saving,        setSaving]        = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [showLangPopup, setShowLangPopup] = useState(false)

  const [stage,        setStage]        = useState<Stage>('edit')
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([])
  const [dupChecked,   setDupChecked]   = useState(false)

  const router   = useRouter()
  const supabase = createClient()

  const placeholder = useMemo(
    () => buildPlaceholder(pairSepOpt, customPairSep, cardSepOpt, customCardSep, targetLang, basisLang),
    [pairSepOpt, customPairSep, cardSepOpt, customCardSep, targetLang, basisLang]
  )

  const effectivePairSep = aiFormatEnabled ? '\t' : sepChar(pairSepOpt, customPairSep)
  const effectiveCardSep = aiFormatEnabled ? '\n' : sepChar(cardSepOpt, customCardSep)

  const parsed = useMemo(() => {
    if (!rawText.trim()) return []
    return parseCards(rawText, effectiveCardSep, effectivePairSep)
  }, [rawText, effectiveCardSep, effectivePairSep])

  const textareaLabel = aiFormatEnabled && aiMode === 'wordlist' ? 'Paste words here' : 'Paste text here'

  const textareaPlaceholder = !aiFormatEnabled
    ? placeholder
    : aiMode === 'wordlist'
      ? 'Enter words to be formatted by AI agent'
      : 'Paste text for word extraction here'

  function ensureLanguages(): boolean {
    if (!targetLang || !basisLang) {
      setShowLangPopup(true)
      return false
    }
    return true
  }

  function handleRawTextChange(value: string) {
    setRawText(value)
    setAgentRan(false)
  }

  function handleAiToggle(checked: boolean) {
    setAiFormatEnabled(checked)
    setAgentRan(false)
    setAgentError(null)
  }

  function handleAiModeChange(mode: AiMode) {
    setAiMode(mode)
    setAgentRan(false)
    setAgentError(null)
  }

  async function handleRunAgent() {
    setAgentError(null)
    if (!ensureLanguages()) return
    if (!rawText.trim()) { setAgentError('Enter some content first.'); return }
    if (wordCount(rawText) > INPUT_WORD_CAP) {
      setAgentError(`Your ${aiMode === 'wordlist' ? 'word list' : 'text'} exceeds the ${INPUT_WORD_CAP}-word limit.`)
      return
    }

    setAgentRunning(true)
    try {
      const body = aiMode === 'wordlist'
        ? { mode: 'wordlist', content: rawText, instructions: aiPrompt, improvedTranslations: false, sourceLanguage: targetLang, targetLanguage: basisLang }
        : { mode: 'extraction', text: rawText, instructions: aiPrompt, improvedTranslations: false, sourceLanguage: targetLang, targetLanguage: basisLang }

      const res  = await fetch('/api/cards/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()

      if (!data.ok) {
        setAgentError(reasonToMessage(data.reason))
        return
      }

      const formatted = (data.cards as CandidateCard[]).map(c => `${c.front}\t${c.back}`).join('\n')
      setRawText(formatted)
      setAgentRan(true)
    } catch {
      setAgentError('Something went wrong running the agent. Please try again.')
    } finally {
      setAgentRunning(false)
    }
  }

  function handlePreview() {
    setError(null)
    if (!ensureLanguages()) return
    if (!deckName.trim() || parsed.length === 0) return

    setPreviewItems(parsed.map(c => ({ front: c.front, back: c.back, include: true, duplicate: null, action: 'create' })))
    setDupChecked(false)
    setStage('preview')
  }

  function updatePreviewItem(i: number, patch: Partial<PreviewItem>) {
    setPreviewItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  function removePreviewItem(i: number) {
    setPreviewItems(prev => prev.filter((_, idx) => idx !== i))
  }

  async function doSave(items: PreviewItem[]) {
    setSaving(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }

      const deckRepo      = new SupabaseDeckRepository()
      const cardRepo      = new SupabaseCardRepository()
      const pipelineRepo  = new SupabasePipelineRepository()
      const dismissedRepo = new SupabaseDismissedPairRepository()

      const pipeline = await pipelineRepo.getDefault()
      const deck = await deckRepo.create(session.user.id, {
        name:           deckName,
        sourceLanguage: targetLang,
        targetLanguage: basisLang,
        pipelineId:     pipeline.id,
      })

      const included = items.filter(it => it.include)
      const toMerge   = included.filter(it => it.action === 'merge' && it.duplicate?.existingCard)
      const toCreate  = included.filter(it => it.action !== 'merge')

      let position = 0
      for (const it of toMerge) {
        await cardRepo.addToDeck(deck.id, it.duplicate!.existingCard!.id, position++)
      }

      let created: Card[] = []
      if (toCreate.length > 0) {
        created = await cardRepo.bulkCreate(deck.id, session.user.id, targetLang, basisLang, toCreate.map(it => ({
          front:    it.front,
          back:     it.back,
          position: position++,
        })))

        for (let i = 0; i < toCreate.length; i++) {
          const it          = toCreate[i]!
          const createdCard = created[i]
          if (it.action === 'keep-both' && it.duplicate?.existingCard && createdCard && createdCard.id !== it.duplicate.existingCard.id) {
            await dismissedRepo.create(session.user.id, it.duplicate.existingCard.id, createdCard.id)
          }
        }
      }

      // Kick off background generation of AI answer choices for newly created cards.
      const prefetchItems: PrefetchItem[] = created.map(card => ({
        card:           { ...card, choices: null },
        side:           'front',
        deckCards:      created,
        sourceLanguage: targetLang,
        targetLanguage: basisLang,
      }))
      void prefetchChoices(prefetchItems, () => {})

      router.push(`/study/${deck.id}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save deck')
      setSaving(false)
    }
  }

  async function handleSaveDeck() {
    setError(null)

    if (!dupChecked) {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/auth'); return }

        const cardRepo = new SupabaseCardRepository()
        const existing = await cardRepo.listOwned(session.user.id, targetLang, basisLang)

        const withDup: PreviewItem[] = previewItems.map(it => {
          const duplicate = analyzeDuplicate({ front: it.front, back: it.back }, existing, targetLang, basisLang)
          return { ...it, duplicate, action: duplicate.tier === 'near' ? 'keep-both' : 'create' }
        })

        setPreviewItems(withDup)
        setDupChecked(true)

        const hasNear = withDup.some(it => it.duplicate?.tier === 'near')
        if (hasNear) return

        await doSave(withDup)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to check for duplicates')
      }
      return
    }

    await doSave(previewItems)
  }

  function handleClear() {
    setRawText('')
    setDeckName('')
    setError(null)
    setAgentError(null)
    setAgentRan(false)
    setStage('edit')
    setPreviewItems([])
    setDupChecked(false)
  }

  // ── Preview stage ─────────────────────────────────────────────────────────

  if (stage === 'preview') {
    const includedCount = previewItems.filter(it => it.include).length
    const nearCount     = previewItems.filter(it => it.duplicate?.tier === 'near').length
    const saveLabel = !dupChecked || nearCount === 0 ? 'Save deck' : 'Confirm & save deck'

    return (
      <div className="space-y-6 max-w-3xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Preview deck</h1>
          <p className="text-ink-muted mt-1">
            {deckName || 'Untitled deck'} — {includedCount} of {previewItems.length} card{previewItems.length !== 1 ? 's' : ''}
          </p>
        </div>

        {dupChecked && nearCount > 0 && (
          <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
            {nearCount} card{nearCount !== 1 ? 's' : ''} look similar to cards you already have — choose whether to keep them as new cards or use the existing ones instead.
          </div>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="space-y-3">
          {previewItems.map((item, i) => (
            <div key={i} className={`panel space-y-3 ${!item.include ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={item.include}
                  onChange={e => updatePreviewItem(i, { include: e.target.checked })}
                  className="accent-accent w-4 h-4 mt-2.5"
                />
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <textarea
                    className="input resize-none min-h-[52px] text-sm font-medium"
                    value={item.front}
                    onChange={e => updatePreviewItem(i, { front: e.target.value })}
                  />
                  <textarea
                    className="input resize-none min-h-[52px] text-sm"
                    value={item.back}
                    onChange={e => updatePreviewItem(i, { back: e.target.value })}
                  />
                </div>
                <button
                  onClick={() => removePreviewItem(i)}
                  className="text-ink-faint hover:text-danger transition-colors text-sm shrink-0 mt-2"
                  title="Remove"
                >
                  ✕
                </button>
              </div>

              {dupChecked && item.duplicate?.tier === 'near' && item.duplicate.existingCard && (
                <div className="pl-7 space-y-2 border-t border-white/10 pt-3">
                  <p className="text-xs text-ink-muted">
                    Similar to existing card: <span className="text-ink">&quot;{item.duplicate.existingCard.front}&quot;</span> / <span className="text-ink">&quot;{item.duplicate.existingCard.back}&quot;</span>
                  </p>
                  <div className="flex gap-4 text-sm">
                    <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                      <input type="radio" name={`dup-${i}`} checked={item.action === 'keep-both'} onChange={() => updatePreviewItem(i, { action: 'keep-both' })} className="accent-accent" />
                      Keep as new card
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                      <input type="radio" name={`dup-${i}`} checked={item.action === 'merge'} onChange={() => updatePreviewItem(i, { action: 'merge' })} className="accent-accent" />
                      Use existing card instead
                    </label>
                  </div>
                </div>
              )}
            </div>
          ))}

          {previewItems.length === 0 && (
            <div className="panel text-center text-ink-muted text-sm py-8">
              No cards left to save.
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button className="btn-primary" disabled={includedCount === 0 || saving} onClick={handleSaveDeck}>
            {saving ? 'Saving…' : saveLabel}
          </button>
          <button className="btn-ghost" disabled={saving} onClick={() => setStage('edit')}>Back</button>
        </div>
      </div>
    )
  }

  // ── Edit stage ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Upload</h1>
        <p className="text-ink-muted mt-1">Please paste your word list below.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-ink-muted">Deck name</label>
        <input className="input" placeholder="e.g. Spanish Elite Vocab" value={deckName} onChange={e => setDeckName(e.target.value)} />
      </div>

      {/* Language pickers */}
      <div className="grid grid-cols-2 gap-4">
        <LanguageCombobox label="Target language" value={targetLang} onChange={setTargetLang} />
        <LanguageCombobox label="Basis language"  value={basisLang}  onChange={setBasisLang}  />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={aiFormatEnabled} onChange={e => handleAiToggle(e.target.checked)} className="accent-accent w-4 h-4" />
            <span className="text-sm text-ink">Format with AI agent</span>
          </label>
          {aiFormatEnabled && <ModeSwitch value={aiMode} onChange={handleAiModeChange} />}
        </div>

        {aiFormatEnabled && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm text-ink-muted">Prompt</label>
              <span className="text-xs text-ink-faint">{aiPrompt.length} / {INSTRUCTIONS_CHAR_CAP}</span>
            </div>
            <textarea
              className="input min-h-[60px] resize-y text-sm"
              maxLength={INSTRUCTIONS_CHAR_CAP}
              placeholder="Prompt: e.g. 'Extract Spanish → English pairs'"
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
            />
          </div>
        )}
      </div>

      {!aiFormatEnabled && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SeparatorPicker label="Front / back separator" value={pairSepOpt} onChange={setPairSepOpt} custom={customPairSep} onCustomChange={setCustomPairSep} />
          <SeparatorPicker label="Between-card separator" value={cardSepOpt} onChange={setCardSepOpt} custom={customCardSep} onCustomChange={setCustomCardSep} />
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-sm text-ink-muted">{textareaLabel}</label>
          {aiFormatEnabled && (
            <span className="text-xs text-ink-faint">
              {wordCount(rawText)} / {INPUT_WORD_CAP} words
            </span>
          )}
        </div>
        <textarea
          className="input min-h-[220px] resize-y font-mono text-sm leading-relaxed"
          placeholder={textareaPlaceholder}
          value={rawText}
          onChange={e => handleRawTextChange(e.target.value)}
        />
      </div>

      {agentError && <p className="text-danger text-sm">{agentError}</p>}

      {!aiFormatEnabled && parsed.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
            Preview — {parsed.length} card{parsed.length !== 1 ? 's' : ''} detected
          </h2>
          <div className="panel space-y-2 max-h-56 overflow-y-auto">
            {parsed.map((card, i) => (
              <div key={i} className="flex gap-4 text-sm">
                <span className="text-ink w-1/2 truncate">{card.front}</span>
                <span className="text-ink-muted w-1/2 truncate">{card.back}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {aiFormatEnabled && agentRan && parsed.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">
            Agent result — {parsed.length} card{parsed.length !== 1 ? 's' : ''} detected
          </h2>
          <div className="panel space-y-2 max-h-56 overflow-y-auto">
            {parsed.map((card, i) => (
              <div key={i} className="flex gap-4 text-sm">
                <span className="text-ink w-1/2 truncate">{card.front}</span>
                <span className="text-ink-muted w-1/2 truncate">{card.back}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="flex gap-3">
        <button
          className="btn-primary"
          disabled={!deckName.trim() || saving || (aiFormatEnabled ? (!agentRan || parsed.length === 0) : parsed.length === 0)}
          onClick={handlePreview}
        >
          Preview deck
        </button>
        {aiFormatEnabled && (
          <button
            className="btn-ghost"
            disabled={agentRunning || !rawText.trim()}
            onClick={handleRunAgent}
          >
            {agentRunning ? 'Running…' : 'Run agent'}
          </button>
        )}
        <button className="btn-ghost" onClick={handleClear}>
          Clear
        </button>
      </div>

      {/* Missing language popup */}
      {showLangPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="panel max-w-sm w-full space-y-4">
            <h2 className="text-lg font-semibold text-ink">Select languages</h2>
            <p className="text-sm text-ink-muted">
              Please choose both the target and basis language before continuing.
            </p>
            <div className="flex justify-end">
              <button onClick={() => setShowLangPopup(false)} className="btn-primary">Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
