'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }     from '@/lib/data/decks'
import { SupabaseCardRepository }     from '@/lib/data/cards'
import { SupabasePipelineRepository } from '@/lib/data/pipelines'
import { LANGUAGES } from '@/lib/languages'

type SeparatorOption = 'tab' | 'newline' | 'custom'
interface ParsedCard { front: string; back: string }

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

function LanguagePicker({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-sm text-ink-muted">{label}</span>
      <select
        className="input text-sm"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        {LANGUAGES.map(l => (
          <option key={l.code} value={l.code}>{l.name}</option>
        ))}
      </select>
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
  const [useAiFormat,   setUseAiFormat]   = useState(false)
  const [aiPrompt,      setAiPrompt]      = useState('')
  const [frontLang,     setFrontLang]     = useState('es')
  const [backLang,      setBackLang]      = useState('en')
  const [saving,        setSaving]        = useState(false)
  const [error,         setError]         = useState<string | null>(null)

  const router   = useRouter()
  const supabase = createClient()

  const placeholder = useMemo(
    () => buildPlaceholder(pairSepOpt, customPairSep, cardSepOpt, customCardSep, frontLang, backLang),
    [pairSepOpt, customPairSep, cardSepOpt, customCardSep, frontLang, backLang]
  )

  const parsed = useMemo(() => {
    if (!rawText.trim()) return []
    return parseCards(rawText, sepChar(cardSepOpt, customCardSep), sepChar(pairSepOpt, customPairSep))
  }, [rawText, pairSepOpt, cardSepOpt, customPairSep, customCardSep])

  async function handleSave() {
    setError(null)
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/auth'); return }

      const deckRepo     = new SupabaseDeckRepository()
      const cardRepo     = new SupabaseCardRepository()
      const pipelineRepo = new SupabasePipelineRepository()

      const pipeline = await pipelineRepo.getDefault()

      const deck = await deckRepo.create(session.user.id, {
        name:           deckName,
        sourceLanguage: frontLang,
        targetLanguage: backLang,
        pipelineId:     pipeline.id,
      })

      await cardRepo.bulkCreate(deck.id, parsed.map((c, i) => ({
        front:    c.front,
        back:     c.back,
        position: i,
      })))

      router.push(`/study/${deck.id}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save deck')
    } finally {
      setSaving(false)
    }
  }

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
        <LanguagePicker label="Front language" value={frontLang} onChange={setFrontLang} />
        <LanguagePicker label="Back language"  value={backLang}  onChange={setBackLang}  />
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={useAiFormat} onChange={e => setUseAiFormat(e.target.checked)} className="accent-accent w-4 h-4" />
          <span className="text-sm text-ink">Format with AI agent?</span>
        </label>
        {useAiFormat && (
          <input className="input" placeholder="Prompt: e.g. 'Extract Spanish → English pairs'" value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} />
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SeparatorPicker label="Front / back separator" value={pairSepOpt} onChange={setPairSepOpt} custom={customPairSep} onCustomChange={setCustomPairSep} />
        <SeparatorPicker label="Between-card separator" value={cardSepOpt} onChange={setCardSepOpt} custom={customCardSep} onCustomChange={setCustomCardSep} />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-ink-muted">Paste text here</label>
        <textarea
          className="input min-h-[220px] resize-y font-mono text-sm leading-relaxed"
          placeholder={placeholder}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
        />
      </div>

      {parsed.length > 0 && (
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

      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="flex gap-3">
        <button
          className="btn-primary"
          disabled={parsed.length === 0 || !deckName.trim() || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : `Save ${parsed.length > 0 ? parsed.length + ' cards' : 'deck'}`}
        </button>
        <button className="btn-ghost" onClick={() => { setRawText(''); setDeckName(''); setError(null) }}>
          Clear
        </button>
      </div>
    </div>
  )
}
