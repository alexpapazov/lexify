'use client'

/**
 * OfflineUploadForm — the offline "Create" page. Mirrors the online create flow (name a deck, pick the
 * languages + separators, paste, preview, place it in a folder) but every write goes to the local store
 * and is queued in the outbox for creation on the server when you next sync. No AI: duplicate detection
 * is the same pure, article-aware check used online (exact + near), and there's no sync/fast-track.
 * Only cards in downloaded language pairs can be duplicate-checked; folders offered are downloaded ones.
 */
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { routes } from '@/lib/routes'
import { getLocalStore } from '@/lib/offline/localStore'
import {
  localOwnedCards, localCreateDeck, localCreateFolder, localCreateCard, localLinkDeckCard,
} from '@/lib/offline/localRepos'
import { LanguageCombobox } from '@/components/LanguageCombobox'
import { langName } from '@/lib/languages'
import { folderMatchesPair, descendantDeckIds } from '@/lib/folderStats'
import { analyzeDuplicate, tier1Match, tier2Match, type DuplicateAnalysis } from '@/lib/duplicates'
import { DEFAULT_GRADING_SETTINGS } from '@/domain'
import type { Card, Deck, Folder } from '@/domain'

const DEFAULT_PIPELINE_ID = '00000000-0000-0000-0000-000000000001'
const NEW_FOLDER_VALUE = '__new__'
const ROOT_FOLDER_VALUE = '__root__'

type SeparatorOption = 'tab' | 'newline' | 'custom'
type Stage = 'edit' | 'preview'

interface ParsedCard { front: string; back: string }
interface PreviewItem {
  front:  string
  back:   string
  duplicate: DuplicateAnalysis | null
  action: 'create' | 'merge'
  batchDuplicateOf?: number
}

function sepChar(opt: SeparatorOption, custom: string): string {
  if (opt === 'tab')     return '\t'
  if (opt === 'newline') return '\n'
  return custom || '\t'
}

function parseCards(raw: string, cardSep: string, pairSep: string): ParsedCard[] {
  return raw.split(cardSep).map(l => l.trim()).filter(Boolean).map(line => {
    const idx = line.indexOf(pairSep)
    if (idx === -1) return null
    return { front: line.slice(0, idx).trim(), back: line.slice(idx + pairSep.length).trim() }
  }).filter((c): c is ParsedCard => c !== null && c.front.length > 0 && c.back.length > 0)
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

/** Folders in this pair's tree (depth-first, with indent depth) — the same shape the online picker uses. */
function buildFolderOptions(folders: Folder[], decks: Deck[], source: string, target: string): Array<{ folder: Folder; depth: number }> {
  const matching = folders.filter(f => {
    if (!folderMatchesPair(f.id, folders, decks, source, target)) return false
    if (f.isSynced && descendantDeckIds(f.id, folders, decks).length === 0) return false
    return true
  })
  const byParent = new Map<string | null, Folder[]>()
  for (const f of matching) { const a = byParent.get(f.parentId) ?? []; a.push(f); byParent.set(f.parentId, a) }
  const result: Array<{ folder: Folder; depth: number }> = []
  function walk(parentId: string | null, depth: number) {
    for (const c of (byParent.get(parentId) ?? []).slice().sort((a, b) => a.position - b.position)) {
      result.push({ folder: c, depth })
      walk(c.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

export function OfflineUploadForm() {
  const [userId,       setUserId]       = useState('')
  const [decks,        setDecks]        = useState<Deck[]>([])
  const [folders,      setFolders]      = useState<Folder[]>([])
  const [deckName,     setDeckName]     = useState('')
  const [targetLang,   setTargetLang]   = useState('')
  const [basisLang,    setBasisLang]    = useState('')
  const [pairSepOpt,   setPairSepOpt]   = useState<SeparatorOption>('tab')
  const [cardSepOpt,   setCardSepOpt]   = useState<SeparatorOption>('newline')
  const [customPairSep, setCustomPairSep] = useState('')
  const [customCardSep, setCustomCardSep] = useState('')
  const [rawText,      setRawText]      = useState('')

  const [stage,        setStage]        = useState<Stage>('edit')
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([])
  const [dupChecked,   setDupChecked]   = useState(false)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [creatingFolder,   setCreatingFolder]   = useState(false)
  const [newFolderName,    setNewFolderName]    = useState('')

  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState<string | null>(null)

  const router = useRouter()

  useEffect(() => {
    ;(async () => {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session) return
      setUserId(session.user.id)
      const store = getLocalStore()
      const [ds, fs] = await Promise.all([store.allDecks(), store.allFolders()])
      setDecks(ds)
      setFolders(fs)
      // Default the pair to the first downloaded deck, so folders/duplicates are meaningful right away.
      if (ds[0]) { setTargetLang(ds[0].sourceLanguage); setBasisLang(ds[0].targetLanguage) }
    })()
  }, [])

  const effectivePairSep = sepChar(pairSepOpt, customPairSep)
  const effectiveCardSep = sepChar(cardSepOpt, customCardSep)

  const parsed = useMemo(
    () => rawText.trim() ? parseCards(rawText, effectiveCardSep, effectivePairSep) : [],
    [rawText, effectiveCardSep, effectivePairSep],
  )

  const duplicateCount = useMemo(() => {
    const seen = new Set<string>()
    return parsed.filter(c => {
      const key = `${c.front.trim().toLowerCase()}|||${c.back.trim().toLowerCase()}`
      if (seen.has(key)) return true
      seen.add(key)
      return false
    }).length
  }, [parsed])

  function removeDuplicates() {
    const seen = new Set<string>()
    const unique = parsed.filter(c => {
      const key = `${c.front.trim().toLowerCase()}|||${c.back.trim().toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    setRawText(unique.map(c => `${c.front}${effectivePairSep}${c.back}`).join(effectiveCardSep))
  }

  function handlePreview() {
    setError(null)
    if (!targetLang || !basisLang) { setError('Choose both the target and basis language first.'); return }
    if (!deckName.trim() || parsed.length === 0) return
    setPreviewItems(parsed.map(c => ({ front: c.front, back: c.back, duplicate: null, action: 'create' })))
    setDupChecked(false)
    setSelectedFolderId(null)
    setCreatingFolder(false)
    setNewFolderName('')
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
      const iso = new Date().toISOString()

      // New folder (offline) if the user chose to create one.
      let folderId = selectedFolderId
      if (creatingFolder && newFolderName.trim()) {
        const folder: Folder = {
          id: crypto.randomUUID(), ownerId: userId, name: newFolderName.trim(), parentId: null, position: 0,
          createdAt: iso, updatedAt: iso, deletedAt: null, isSynced: false, sourceLanguage: null, targetLanguage: null,
        }
        await localCreateFolder(folder)
        folderId = folder.id
      }

      const deck: Deck = {
        id: crypto.randomUUID(), ownerId: userId, name: deckName.trim(),
        sourceLanguage: targetLang, targetLanguage: basisLang, pipelineId: DEFAULT_PIPELINE_ID,
        gradingSettings: DEFAULT_GRADING_SETTINGS, isPublic: false, isPinned: false,
        folderId: folderId ?? null, position: 0, syncingComplete: true,
        createdAt: iso, updatedAt: iso, deletedAt: null,
      }
      await localCreateDeck(deck)

      let position = 0
      for (const it of items) {
        if (it.action === 'merge' && it.duplicate?.existingCard) {
          await localLinkDeckCard(deck.id, it.duplicate.existingCard.id, position++)
          continue
        }
        const card: Card = {
          id: crypto.randomUUID(), ownerId: userId, sourceLanguage: targetLang, targetLanguage: basisLang,
          front: it.front, back: it.back, hints: [], choices: null, position: position++,
          createdAt: iso, updatedAt: iso, deletedAt: null,
          synonymGroupId: null, register: null, region: null,
          syncedFromLanguages: [], originWords: [],
          audioGenerated: false, audioData: null, audioSource: null, audioSources: null, ipa: null,
        }
        await localCreateCard(card, deck.id)
      }

      router.push(routes.deck(deck.id))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save deck')
      setSaving(false)
    }
  }

  async function handleSaveDeck() {
    setError(null)
    if (!dupChecked) {
      const existing = await localOwnedCards(targetLang, basisLang)
      const withDup: PreviewItem[] = previewItems.map((it, idx) => {
        const duplicate = analyzeDuplicate({ front: it.front, back: it.back }, existing, targetLang, basisLang)
        if (duplicate.tier !== 'none') {
          return { ...it, duplicate, action: duplicate.tier === 'near' ? 'merge' as const : 'create' as const }
        }
        // Not in the library — is it a duplicate of an earlier card in this same batch?
        for (let j = 0; j < idx; j++) {
          const other = previewItems[j]!
          const a = { front: it.front, back: it.back }
          const b = { front: other.front, back: other.back }
          if (tier1Match(a, b) || tier2Match(a, b, targetLang, basisLang)) {
            return { ...it, duplicate: { tier: 'near' as const, existingCard: null }, action: 'create' as const, batchDuplicateOf: j }
          }
        }
        return { ...it, duplicate, action: 'create' as const }
      })
      setPreviewItems(withDup)
      setDupChecked(true)
      const hasFlag = withDup.some(it => it.duplicate?.tier === 'near' || it.duplicate?.tier === 'exact')
      if (hasFlag) return
      await doSave(withDup)
      return
    }
    await doSave(previewItems)
  }

  function handleClear() {
    setRawText('')
    setDeckName('')
    setError(null)
    setStage('edit')
    setPreviewItems([])
    setDupChecked(false)
  }

  // ── Preview stage ───────────────────────────────────────────────────────────
  if (stage === 'preview') {
    const nearCount    = previewItems.filter(it => it.duplicate?.tier === 'near').length
    const exactCount   = previewItems.filter(it => it.duplicate?.tier === 'exact').length
    const flaggedCount = nearCount + exactCount
    const saveLabel = !dupChecked || flaggedCount === 0 ? 'Save deck' : 'Confirm & save deck'
    const folderOptions = buildFolderOptions(folders, decks, targetLang, basisLang)

    return (
      <div className="space-y-6 max-w-3xl mx-auto pb-12">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Preview deck</h1>
          <p className="text-ink-muted mt-1">{deckName || 'Untitled deck'} — {previewItems.length} card{previewItems.length !== 1 ? 's' : ''}</p>
        </div>

        {dupChecked && flaggedCount > 0 && (
          <div className="border border-warning/30 bg-warning/5 rounded-lg px-4 py-3 text-sm text-ink-muted">
            {flaggedCount} card{flaggedCount !== 1 ? 's' : ''} {flaggedCount !== 1 ? 'are' : 'is'} flagged below
            {exactCount > 0 && nearCount > 0 && ` — ${exactCount} already in your library, ${nearCount} similar`}
            {exactCount > 0 && nearCount === 0 && ` — already in your library`}
            {exactCount === 0 && nearCount > 0 && ` — similar to existing or other cards in this list`}
            . Review them before saving.
          </div>
        )}

        {error && <p className="text-danger text-sm">{error}</p>}

        <div className="space-y-3">
          {previewItems.map((item, i) => (
            <div key={i} className="panel space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <textarea className="input resize-none min-h-[52px] text-sm font-medium" value={item.front} onChange={e => updatePreviewItem(i, { front: e.target.value })} />
                  <textarea className="input resize-none min-h-[52px] text-sm" value={item.back} onChange={e => updatePreviewItem(i, { back: e.target.value })} />
                </div>
                <button onClick={() => removePreviewItem(i)} className="text-ink-faint hover:text-danger transition-colors text-sm shrink-0 mt-2" title="Remove">✕</button>
              </div>

              {dupChecked && item.duplicate?.tier === 'exact' && (
                <div className="space-y-2 border-t border-line/10 pt-3">
                  <p className="text-xs text-ink-muted">Already in your library. X out this card if you don&apos;t want to add the duplicate to this deck.</p>
                </div>
              )}

              {dupChecked && item.duplicate?.tier === 'near' && (
                <div className="space-y-2 border-t border-line/10 pt-3">
                  {item.duplicate.existingCard ? (
                    <>
                      <p className="text-xs text-ink-muted">
                        Similar to existing card: <span className="text-ink">&quot;{item.duplicate.existingCard.front}&quot;</span> / <span className="text-ink">&quot;{item.duplicate.existingCard.back}&quot;</span>
                      </p>
                      <div className="flex flex-wrap gap-4 text-sm">
                        <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                          <input type="radio" name={`dup-${i}`} checked={item.action === 'create'} onChange={() => updatePreviewItem(i, { action: 'create' })} className="accent-accent" />
                          Keep as new card
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                          <input type="radio" name={`dup-${i}`} checked={item.action === 'merge'} onChange={() => updatePreviewItem(i, { action: 'merge' })} className="accent-accent" />
                          Use existing card instead
                        </label>
                      </div>
                    </>
                  ) : item.batchDuplicateOf !== undefined ? (
                    <>
                      <p className="text-xs text-ink-muted">
                        Looks like a duplicate of card #{item.batchDuplicateOf + 1} above: <span className="text-ink">&quot;{previewItems[item.batchDuplicateOf]?.front}&quot;</span> / <span className="text-ink">&quot;{previewItems[item.batchDuplicateOf]?.back}&quot;</span>
                      </p>
                      <button type="button" onClick={() => removePreviewItem(i)} className="btn-ghost text-xs px-3 py-1">Remove this card</button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ))}
          {previewItems.length === 0 && (
            <div className="panel text-center text-ink-muted text-sm py-8">No cards left to save.</div>
          )}
        </div>

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
              <option key={folder.id} value={folder.id}>{'  '.repeat(depth)}{folder.name}</option>
            ))}
            <option value={NEW_FOLDER_VALUE}>+ New folder…</option>
          </select>
          {creatingFolder && (
            <input autoFocus className="input text-sm" placeholder="New folder name…" value={newFolderName} onChange={e => setNewFolderName(e.target.value)} />
          )}
        </div>

        {dupChecked && exactCount > 0 && (
          <button type="button" className="btn-ghost text-sm text-danger/80 hover:text-danger self-start" onClick={() => setPreviewItems(prev => prev.filter(it => it.duplicate?.tier !== 'exact'))}>
            Remove all exact duplicates ({exactCount})
          </button>
        )}

        <div className="flex gap-3">
          <button className="btn-primary" disabled={previewItems.length === 0 || saving} onClick={handleSaveDeck}>{saving ? 'Saving…' : saveLabel}</button>
          <button className="btn-ghost" disabled={saving} onClick={() => setStage('edit')}>Back</button>
        </div>
        <p className="text-xs text-ink-faint">Offline — the deck is saved on this device and created in the cloud when you next sync.</p>
      </div>
    )
  }

  // ── Edit stage ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Create</h1>
        <p className="text-ink-muted mt-1">Offline — cards are saved on this device and created in the cloud when you next sync.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-ink-muted">Deck name</label>
        <input className="input" placeholder="e.g. Spanish Elite Vocab" value={deckName} onChange={e => setDeckName(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <LanguageCombobox label="Target language" value={targetLang} onChange={setTargetLang} />
        <LanguageCombobox label="Basis language"  value={basisLang}  onChange={setBasisLang}  />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SeparatorPicker label="Front / back separator" value={pairSepOpt} onChange={setPairSepOpt} custom={customPairSep} onCustomChange={setCustomPairSep} />
        <SeparatorPicker label="Between-card separator" value={cardSepOpt} onChange={setCardSepOpt} custom={customCardSep} onCustomChange={setCustomCardSep} />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm text-ink-muted">Paste text here</label>
        <textarea
          className="input min-h-[220px] resize-y font-mono text-sm leading-relaxed"
          placeholder={'hola\thello\ngato\tcat'}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
        />
      </div>

      {parsed.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-muted uppercase tracking-wider">Preview — {parsed.length} card{parsed.length !== 1 ? 's' : ''} detected</h2>
            {duplicateCount > 0 && (
              <button type="button" onClick={removeDuplicates} className="text-xs text-ink-faint hover:text-danger transition-colors">
                Remove {duplicateCount} exact duplicate{duplicateCount !== 1 ? 's' : ''}
              </button>
            )}
          </div>
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
        <button className="btn-primary" disabled={!deckName.trim() || saving || parsed.length === 0} onClick={handlePreview}>Preview deck</button>
        <button className="btn-ghost" onClick={handleClear}>Clear</button>
      </div>
    </div>
  )
}
