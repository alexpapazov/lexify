'use client'

import { useState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SupabaseDeckRepository }              from '@/lib/data/decks'
import { SupabaseCardRepository }              from '@/lib/data/cards'
import { SupabaseCardStateRepository }         from '@/lib/data/cardStates'
import { SupabasePipelineRepository }          from '@/lib/data/pipelines'
import { SupabaseDismissedPairRepository }     from '@/lib/data/dismissedPairs'
import { SupabaseFolderRepository }            from '@/lib/data/folders'
import { SupabaseLanguageSyncRuleRepository }  from '@/lib/data/languageSyncRules'
import { SupabaseLanguagePairRepository }      from '@/lib/data/languagePairs'
import { fastTrackCardState }                  from '@/engine/pipeline'
import { batchFastTrackDueDates }              from '@/engine/density'
import { LanguageCombobox } from '@/components/LanguageCombobox'
import { prefetchChoices, type PrefetchItem } from '@/lib/distractors'
import { folderMatchesPair, descendantDeckIds } from '@/lib/folderStats'
import { langName } from '@/lib/languages'
import {
  INSTRUCTIONS_CHAR_CAP, INPUT_WORD_CAP,
  analyzeDuplicate, type DuplicateAnalysis,
  tier1Match, tier2Match,
} from '@/lib/duplicates'
import type { Card, Folder, Deck, LanguagePair } from '@/domain'

const NEW_FOLDER_VALUE = '__new__'
const ROOT_FOLDER_VALUE = '__root__'

/**
 * Flatten the folders that belong to a language pairing (per
 * `folderMatchesPair`) into a depth-first list with indentation depth, for
 * use in a flat <select> picker.
 */
function buildFolderOptions(folders: Folder[], decks: Deck[], sourceLanguage: string, targetLanguage: string): Array<{ folder: Folder; depth: number }> {
  // Exclude synced folders with no descendant decks — empty, shouldn't be offered as destinations
  const matching = folders.filter(f => {
    if (!folderMatchesPair(f.id, folders, decks, sourceLanguage, targetLanguage)) return false
    if (f.isSynced) {
      const dIds: string[] = descendantDeckIds(f.id, folders, decks)
      if (dIds.length === 0) return false
    }
    return true
  })
  const byParent = new Map<string | null, Folder[]>()
  for (const f of matching) {
    const arr = byParent.get(f.parentId) ?? []
    arr.push(f)
    byParent.set(f.parentId, arr)
  }
  const result: Array<{ folder: Folder; depth: number }> = []
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.position - b.position)
    for (const c of children) {
      result.push({ folder: c, depth })
      walk(c.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

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
  front:           string
  back:            string
  duplicate:       DuplicateAnalysis | null
  action:          'create' | 'merge' | 'keep-both' | 'delete-existing'
  /** Index of an earlier item in this same preview list that this one looks like a near-duplicate of (not yet saved, so no existing card to merge with). */
  batchDuplicateOf?: number
  /** Names of decks the matched existing card (Tier-1 exact match) already belongs to. */
  existingCardDeckNames?: string[]
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
  /** Indices (into `parsed`) of agent-result cards whose front/back language still looks off after auto-fixing reversed pairs. */
  const [agentWarningLines, setAgentWarningLines] = useState<number[]>([])

  const [targetLang,    setTargetLang]    = useState('')
  const [basisLang,     setBasisLang]     = useState('')
  const [saving,        setSaving]        = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [showLangPopup, setShowLangPopup] = useState(false)

  const [stage,        setStage]        = useState<Stage>('edit')
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([])
  const [dupChecked,   setDupChecked]   = useState(false)

  // Folder picker (shown on the preview stage)
  const [folders,          setFolders]          = useState<Folder[]>([])
  const [decksForFolders,  setDecksForFolders]  = useState<Deck[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [creatingFolder,   setCreatingFolder]   = useState(false)
  const [newFolderName,    setNewFolderName]    = useState('')

  // Sync checkbox (shown on the preview stage when rules exist)
  const [hasSyncRules, setHasSyncRules] = useState(false)
  const [syncEnabled,  setSyncEnabled]  = useState(true)

  // Fast-track graduated review
  const [fastTrackEnabled,  setFastTrackEnabled]  = useState(false)
  const [fastTrackCardIds,  setFastTrackCardIds]  = useState<Set<number>>(new Set())
  const [syncFastTrackMode, setSyncFastTrackMode] = useState<'none' | 'new_only'>('new_only')

  // All language pairs for the current user (loaded on mount for instructions fallback)
  const [allPairsCache, setAllPairsCache] = useState<LanguagePair[]>([])

  const router   = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return
      const pairRepo = new SupabaseLanguagePairRepository()
      const pairs = await pairRepo.list(session.user.id)
      setAllPairsCache(pairs)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    setAgentWarningLines([])
  }

  function handleAiToggle(checked: boolean) {
    setAiFormatEnabled(checked)
    setAgentRan(false)
    setAgentError(null)
    setAgentWarningLines([])
  }

  function handleAiModeChange(mode: AiMode) {
    setAiMode(mode)
    setAgentRan(false)
    setAgentError(null)
    setAgentWarningLines([])
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
      // If user hasn't typed a custom prompt, fall back to the language pair's saved instructions
      const pairDefaultInstructions = aiPrompt.trim()
        ? aiPrompt
        : (allPairsCache.find(p => p.sourceLanguage === targetLang && p.targetLanguage === basisLang)?.instructions ?? '')
      const body = aiMode === 'wordlist'
        ? { mode: 'wordlist', content: rawText, instructions: pairDefaultInstructions, improvedTranslations: false, sourceLanguage: targetLang, targetLanguage: basisLang }
        : { mode: 'extraction', text: rawText, instructions: pairDefaultInstructions, improvedTranslations: false, sourceLanguage: targetLang, targetLanguage: basisLang }

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

      // If the agent flagged a card as 'both' sides being in the wrong
      // language, it's almost always a fully reversed pair (front/back
      // swapped) — auto-fix by swapping them back. Cards still flagged on
      // just one side afterwards are surfaced as warnings for the user to
      // review, since those usually mean a mistranslation rather than a
      // simple swap.
      const warningLines: number[] = []
      const fixedCards = (data.cards as CandidateCard[]).map((c, idx) => {
        if (c.languageWarning === 'both') {
          return { front: c.back, back: c.front }
        }
        if (c.languageWarning === 'front' || c.languageWarning === 'back') {
          warningLines.push(idx)
        }
        return { front: c.front, back: c.back }
      })

      const formatted = fixedCards.map(c => `${c.front}\t${c.back}`).join('\n')
      setRawText(formatted)
      setAgentWarningLines(warningLines)
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

    setPreviewItems(parsed.map(c => ({ front: c.front, back: c.back, duplicate: null, action: 'create' })))
    setDupChecked(false)
    setSelectedFolderId(null)
    setCreatingFolder(false)
    setNewFolderName('')
    setFastTrackEnabled(false)
    setFastTrackCardIds(new Set())
    setStage('preview')
    void loadFolderOptions()
  }

  /** Load this user's folders/decks and sync rules for the preview stage. */
  async function loadFolderOptions() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    const folderRepo = new SupabaseFolderRepository()
    const deckRepo   = new SupabaseDeckRepository()
    const pairRepo   = new SupabaseLanguagePairRepository()
    const ruleRepo   = new SupabaseLanguageSyncRuleRepository()
    const [allFolders, allDecks, allPairs, allRules] = await Promise.all([
      folderRepo.list(session.user.id),
      deckRepo.list(session.user.id),
      pairRepo.list(session.user.id),
      ruleRepo.listForUser(session.user.id),
    ])
    // Delete empty synced vocabulary folders (stale remnants from old sync operations)
    const emptySynced = allFolders.filter(f => {
      if (!f.isSynced) return false
      return descendantDeckIds(f.id, allFolders, allDecks).length === 0
    })
    if (emptySynced.length > 0) {
      await Promise.all(emptySynced.map(f => folderRepo.softDelete(f.id)))
      const deletedIds = new Set(emptySynced.map(f => f.id))
      setFolders(allFolders.filter(f => !deletedIds.has(f.id)))
    } else {
      setFolders(allFolders)
    }
    setDecksForFolders(allDecks)
    const sourcePair = allPairs.find(p => p.sourceLanguage === targetLang && p.targetLanguage === basisLang)
    const hasRules = sourcePair ? allRules.some(r => r.enabled && r.sourcePairId === sourcePair.id) : false
    setHasSyncRules(hasRules)
    setSyncEnabled(hasRules)
  }

  function handleFastTrackToggle(enabled: boolean) {
    setFastTrackEnabled(enabled)
    if (enabled) {
      setFastTrackCardIds(new Set(previewItems.map((_, i) => i)))
    } else {
      setFastTrackCardIds(new Set())
    }
  }

  function toggleFastTrackCard(i: number) {
    setFastTrackCardIds(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
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

      // Place the new deck in the chosen folder (creating it first if the
      // user typed a new folder name), within this language pairing's tree.
      let folderId = selectedFolderId
      if (creatingFolder) {
        const name = newFolderName.trim()
        if (name) {
          if (name.toUpperCase() === 'SYNCED VOCABULARY') {
            setError('"SYNCED VOCABULARY" is reserved for automatically synced cards.')
            setSaving(false)
            return
          }
          const folderRepo = new SupabaseFolderRepository()
          const newFolder  = await folderRepo.create(session.user.id, name, null)
          folderId = newFolder.id
        }
      }
      if (folderId) {
        await deckRepo.update(deck.id, { folderId })
      }

      const toMerge   = items.filter(it => it.action === 'merge' && it.duplicate?.existingCard)
      const toCreate  = items.filter(it => it.action !== 'merge')

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
          if (it.action === 'delete-existing' && it.duplicate?.existingCard && createdCard && createdCard.id !== it.duplicate.existingCard.id) {
            await cardRepo.softDelete(it.duplicate.existingCard.id)
          }
        }
      }

      // Create fast-track CardStates for selected import-known cards.
      // Build the list of fast-tracked cards (needed both for state upsert and sync payload).
      const itemToCard = new Map<number, Card>()
      let createIdx = 0
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!
        if (it.action === 'merge' && it.duplicate?.existingCard) {
          itemToCard.set(i, it.duplicate.existingCard)
        } else {
          const card = created[createIdx]
          if (card) itemToCard.set(i, card)
          createIdx++
        }
      }
      const fastTrackedCards = fastTrackEnabled
        ? Array.from(fastTrackCardIds).map(idx => itemToCard.get(idx)).filter((c): c is Card => c != null)
        : []

      if (fastTrackedCards.length > 0) {
        const stateRepo = new SupabaseCardStateRepository()
        const now      = new Date()
        const dueDates = await batchFastTrackDueDates(session.user.id, fastTrackedCards.length, now, stateRepo)
        const states   = fastTrackedCards.map((c, i) =>
          fastTrackCardState(session.user.id, c.id, pipeline.id, dueDates[i]!, 30, now)
        )
        await stateRepo.upsertBatch(states)
      }

      // Trigger language sync server-side (survives tab switching / browser close).
      // Include both newly created cards AND merged (existing) cards — a word that
      // already existed in this language still needs to reach the synced libraries.
      const mergedCards = toMerge
        .map(it => it.duplicate?.existingCard)
        .filter((c): c is Card => c != null)
      const cardsToSync = [
        ...created.map(c => ({ id: c.id, front: c.front, back: c.back })),
        ...mergedCards.map(c => ({ id: c.id, front: c.front, back: c.back })),
      ]
      if (syncEnabled && cardsToSync.length > 0) {
        void fetch('/api/sync', {
          method:  'POST',
          headers: {
            'content-type':  'application/json',
            'authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            sourceLanguage: targetLang,
            targetLanguage: basisLang,
            cards: cardsToSync,
            fastTrackSyncMode: fastTrackEnabled ? syncFastTrackMode : 'none',
            fastTrackSourceCardIds: fastTrackEnabled && syncFastTrackMode === 'new_only'
              ? fastTrackedCards.map(c => c.id)
              : undefined,
          }),
        })
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

        const withDup: PreviewItem[] = previewItems.map((it, idx) => {
          const duplicate = analyzeDuplicate({ front: it.front, back: it.back }, existing, targetLang, basisLang)
          if (duplicate.tier !== 'none') {
            return { ...it, duplicate, action: duplicate.tier === 'near' ? 'keep-both' as const : 'create' as const }
          }

          // No match in the saved library — check whether this looks like a
          // near/exact duplicate of an earlier card in this same batch (which
          // wouldn't show up in `existing` since neither is saved yet).
          for (let j = 0; j < idx; j++) {
            const other = previewItems[j]!
            const a = { front: it.front, back: it.back }
            const b = { front: other.front, back: other.back }
            if (tier1Match(a, b) || tier2Match(a, b, targetLang, basisLang)) {
              return { ...it, duplicate: { tier: 'near' as const, existingCard: null }, action: 'keep-both' as const, batchDuplicateOf: j }
            }
          }

          return { ...it, duplicate, action: 'create' as const }
        })

        // For exact (Tier-1) matches, look up which deck(s) the existing card
        // already lives in, so we can tell the user where the duplicate is.
        const exactCardIds = [...new Set(
          withDup
            .filter(it => it.duplicate?.tier === 'exact' && it.duplicate.existingCard)
            .map(it => it.duplicate!.existingCard!.id)
        )]
        const deckNamesByCard = await cardRepo.listDeckNamesForCards(exactCardIds)
        const withDeckNames = withDup.map(it =>
          it.duplicate?.tier === 'exact' && it.duplicate.existingCard
            ? { ...it, existingCardDeckNames: deckNamesByCard[it.duplicate.existingCard.id] ?? [] }
            : it
        )

        setPreviewItems(withDeckNames)
        setDupChecked(true)

        const hasFlag = withDeckNames.some(it => it.duplicate?.tier === 'near' || it.duplicate?.tier === 'exact')
        if (hasFlag) return

        await doSave(withDeckNames)
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
    setFastTrackEnabled(false)
    setFastTrackCardIds(new Set())
  }

  // ── Preview stage ─────────────────────────────────────────────────────────

  if (stage === 'preview') {
    const nearCount     = previewItems.filter(it => it.duplicate?.tier === 'near').length
    const exactCount    = previewItems.filter(it => it.duplicate?.tier === 'exact').length
    const flaggedCount  = nearCount + exactCount
    const saveLabel = !dupChecked || flaggedCount === 0 ? 'Save deck' : 'Confirm & save deck'

    return (
      <div className="space-y-6 max-w-3xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Preview deck</h1>
          <p className="text-ink-muted mt-1">
            {deckName || 'Untitled deck'} — {previewItems.length} card{previewItems.length !== 1 ? 's' : ''}
          </p>
        </div>

        {dupChecked && flaggedCount > 0 && (
          <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
            {flaggedCount} card{flaggedCount !== 1 ? 's' : ''} {flaggedCount !== 1 ? 'are' : 'is'} flagged below
            {exactCount > 0 && nearCount > 0 && ` — ${exactCount} already in your library, ${nearCount} similar to existing or other cards in this list`}
            {exactCount > 0 && nearCount === 0 && ` — already in your library`}
            {exactCount === 0 && nearCount > 0 && ` — similar to existing cards or other cards in this list`}
            . Review them before saving.
          </div>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="space-y-3">
          {previewItems.map((item, i) => (
            <div key={i} className="panel space-y-3">
              <div className="flex items-start gap-3">
                {fastTrackEnabled && (
                  <input
                    type="checkbox"
                    checked={fastTrackCardIds.has(i)}
                    onChange={() => toggleFastTrackCard(i)}
                    className="accent-accent w-4 h-4 mt-3 shrink-0"
                    title="Include in fast-track"
                  />
                )}
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

              {dupChecked && item.duplicate?.tier === 'exact' && item.duplicate.existingCard && (
                <div className="pl-7 space-y-2 border-t border-white/10 pt-3">
                  <p className="text-xs text-ink-muted">
                    {item.existingCardDeckNames && item.existingCardDeckNames.length > 0
                      ? <>Already in <span className="text-ink">{item.existingCardDeckNames.join(', ')}</span>.</>
                      : 'Already in your library, but not currently in any deck.'} X out this card if you do not want to add this duplicate to this deck.
                  </p>
                </div>
              )}

              {dupChecked && item.duplicate?.tier === 'near' && (
                <div className="pl-7 space-y-2 border-t border-white/10 pt-3">
                  {item.duplicate.existingCard ? (
                    <>
                      <p className="text-xs text-ink-muted">
                        Similar to existing card: <span className="text-ink">&quot;{item.duplicate.existingCard.front}&quot;</span> / <span className="text-ink">&quot;{item.duplicate.existingCard.back}&quot;</span>
                      </p>
                      <div className="flex flex-wrap gap-4 text-sm">
                        <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                          <input type="radio" name={`dup-${i}`} checked={item.action === 'keep-both'} onChange={() => updatePreviewItem(i, { action: 'keep-both' })} className="accent-accent" />
                          Keep as new card
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                          <input type="radio" name={`dup-${i}`} checked={item.action === 'merge'} onChange={() => updatePreviewItem(i, { action: 'merge' })} className="accent-accent" />
                          Use existing card instead
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                          <input type="radio" name={`dup-${i}`} checked={item.action === 'delete-existing'} onChange={() => updatePreviewItem(i, { action: 'delete-existing' })} className="accent-accent" />
                          Delete other existing card
                        </label>
                      </div>
                      {item.action === 'delete-existing' && (
                        <p className="text-xs text-warning">
                          This will permanently delete the existing card &quot;{item.duplicate.existingCard.front}&quot; / &quot;{item.duplicate.existingCard.back}&quot; everywhere it appears.
                        </p>
                      )}
                    </>
                  ) : item.batchDuplicateOf !== undefined ? (
                    <>
                      <p className="text-xs text-ink-muted">
                        Looks like a duplicate of card #{item.batchDuplicateOf + 1} above: <span className="text-ink">&quot;{previewItems[item.batchDuplicateOf]?.front}&quot;</span> / <span className="text-ink">&quot;{previewItems[item.batchDuplicateOf]?.back}&quot;</span>
                      </p>
                      <button type="button" onClick={() => removePreviewItem(i)} className="btn-ghost text-xs px-3 py-1">
                        Remove this card
                      </button>
                    </>
                  ) : null}
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

        {(() => {
          const folderOptions = buildFolderOptions(folders, decksForFolders, targetLang, basisLang)
          return (
            <div className="space-y-1.5 max-w-sm">
              <label className="text-sm text-ink-muted">Save to folder</label>
              <select
                className="input text-sm"
                value={creatingFolder ? NEW_FOLDER_VALUE : (selectedFolderId ?? ROOT_FOLDER_VALUE)}
                onChange={e => {
                  const v = e.target.value
                  if (v === NEW_FOLDER_VALUE) { setCreatingFolder(true); setNewFolderName('') }
                  else { setCreatingFolder(false); setSelectedFolderId(v === ROOT_FOLDER_VALUE ? null : v) }
                }}
              >
                <option value={ROOT_FOLDER_VALUE}>{langName(targetLang)} / {langName(basisLang)} — root</option>
                {folderOptions.map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {'  '.repeat(depth)}{folder.name}
                  </option>
                ))}
                <option value={NEW_FOLDER_VALUE}>+ New folder…</option>
              </select>
              {creatingFolder && (
                <input
                  autoFocus
                  className="input text-sm"
                  placeholder="New folder name…"
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                />
              )}
            </div>
          )
        })()}

        <div className="flex flex-col gap-3">
          {hasSyncRules && (
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={syncEnabled}
                onChange={e => setSyncEnabled(e.target.checked)}
                className="accent-accent w-4 h-4"
              />
              Sync to other languages
            </label>
          )}

          <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={fastTrackEnabled}
              onChange={e => handleFastTrackToggle(e.target.checked)}
              className="accent-accent w-4 h-4"
            />
            I already know some of these words (fast-track graduated review)
          </label>
          {fastTrackEnabled && (
            <p className="text-xs text-ink-faint pl-6">
              Checked cards ({fastTrackCardIds.size}) will be fast-tracked — uncheck any you still want to learn from scratch
            </p>
          )}
          {fastTrackEnabled && hasSyncRules && syncEnabled && (
            <div className="pl-6 space-y-1.5">
              <p className="text-xs text-ink-muted">Apply fast-track to synced cards too?</p>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                  <input type="radio" name="syncFastTrack" checked={syncFastTrackMode === 'none'} onChange={() => setSyncFastTrackMode('none')} className="accent-accent" />
                  No
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                  <input type="radio" name="syncFastTrack" checked={syncFastTrackMode === 'new_only'} onChange={() => setSyncFastTrackMode('new_only')} className="accent-accent" />
                  Yes, for new synced cards
                </label>
              </div>
            </div>
          )}

          {dupChecked && exactCount > 0 && (
            <button
              type="button"
              className="btn-ghost text-sm text-danger/80 hover:text-danger self-start"
              onClick={() => setPreviewItems(prev => prev.filter(it => it.duplicate?.tier !== 'exact'))}
            >
              Remove all exact duplicates ({exactCount})
            </button>
          )}

          <div className="flex gap-3">
            <button className="btn-primary" disabled={previewItems.length === 0 || saving} onClick={handleSaveDeck}>
              {saving ? 'Saving…' : saveLabel}
            </button>
            <button className="btn-ghost" disabled={saving} onClick={() => setStage('edit')}>Back</button>
          </div>
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
              <div key={i} className={`flex gap-4 text-sm ${agentWarningLines.includes(i) ? 'text-warning' : ''}`}>
                <span className={`w-1/2 truncate ${agentWarningLines.includes(i) ? '' : 'text-ink'}`}>{card.front}</span>
                <span className={`w-1/2 truncate ${agentWarningLines.includes(i) ? '' : 'text-ink-muted'}`}>{card.back}</span>
              </div>
            ))}
          </div>
          {agentWarningLines.length > 0 && (
            <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
              {agentWarningLines.length === 1 ? 'Card' : 'Cards'} {agentWarningLines.map(i => `#${i + 1}`).join(', ')} {agentWarningLines.length === 1 ? 'doesn\'t' : 'don\'t'} look like {agentWarningLines.length === 1 ? "it's" : "they're"} in the expected language on one side — double-check the highlighted row{agentWarningLines.length !== 1 ? 's' : ''} above before saving.
            </div>
          )}
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
